
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Photo, FilterState, ViewMode, Language, FamilyTreeData, FaceRecognitionIndex, PhotoSimilarityIndex } from './types';
import { FamilyTree } from './components/FamilyTree';
import { PhotoGallery } from './components/PhotoGallery';
import { PhotoEditor } from './components/PhotoEditor';
import { PhotoPresentation } from './components/PhotoPresentation';
import { useViewportEdge, type PhotoNavigationProps } from './components/PhotoNavigation';
import { UploadZone, UploadProgressPanel, type UploadProgress } from './components/UploadZone';
import { SettingsModal } from './components/SettingsModal';
import { JobsButton, JobsPopup, type PhotoSimilarityJob } from './components/JobsPopup';
import { translations } from './utils/translations';
import { Search, LayoutGrid, PlusCircle, Shuffle, Users, Filter, Settings, RefreshCw, Download, AlertTriangle, Edit3, GitBranch, LogIn, LogOut, Lock } from 'lucide-react';
import { storageService } from './services/storageService';
import { currentFirebaseUser, signInWithGoogle, signOutOfFirebase, isPermissionDenied } from './services/firebaseApp';
import { prepareImageUpload } from './utils/imageUpload';
import { collectArchivePeople, personNameKey, renamePhotoPerson } from './utils/people';
import { displaySource } from './utils/thumbnails';
import { comparePhotoDates } from './utils/photoDates';
import { useBackgroundFaceRecognition } from './hooks/useBackgroundFaceRecognition';
import { useBackgroundPhotoSimilarity } from './hooks/useBackgroundPhotoSimilarity';
import { useAutomaticPhotoSuggestions } from './hooks/useAutomaticPhotoSuggestions';
import { applyAutomaticPhotoSuggestions, type SuggestionDomains } from './utils/automaticPhotoSuggestions';
import { similaritySourceRevision } from './services/sceneEmbedding';

// Simple UUID generator fallback
const generateId = () => Math.random().toString(36).substr(2, 9);

const App: React.FC = () => {
  const [familyTree, setFamilyTree] = useState<FamilyTreeData | null>(null);
  const familyTreeRef = useRef(familyTree);
  familyTreeRef.current = familyTree;
  const [treeLoadError, setTreeLoadError] = useState(false);
  const [treeSaving, setTreeSaving] = useState(false);
  const loadVersion = useRef(0);
  const renderedArchiveVersion = loadVersion.current;
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [photoSequence, setPhotoSequence] = useState<string[]>([]);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const navigationEdge = useViewportEdge();
  const [viewMode, setViewMode] = useState<ViewMode>('gallery');
  const [showSettings, setShowSettings] = useState(false);
  const [showJobs, setShowJobs] = useState(false);
  const [similarityJob, setSimilarityJob] = useState<PhotoSimilarityJob | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadSummary, setUploadSummary] = useState<{ saved: number; failed: number; total: number } | null>(null);
  const uploadingRef = useRef(false);
  const [photoSaveErrors, setPhotoSaveErrors] = useState<Record<string, boolean>>({});
  const photoSaveVersions = useRef(new Map<string, number>());
  const committedPhotos = useRef(new Map<string, Photo>());
  const deletedPhotoIds = useRef(new Set<string>());
  const replacingPhotoIds = useRef(new Set<string>());
  const [photoMutations, setPhotoMutations] = useState(0);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [fsNeeded, setFsNeeded] = useState(false);
  // Cloud archive access: sign-in is required, and the rules may still refuse the account.
  const [cloudGate, setCloudGate] = useState<null | 'signin' | 'denied'>(null);
  const [cloudEmail, setCloudEmail] = useState<string | null>(null);
  const [signInError, setSignInError] = useState(false);
  const archiveBlocked = fsNeeded || cloudGate !== null;
  
  // Initialize language from storage service
  const [language, setLanguage] = useState<Language>(storageService.getSettings().language);
  const t = translations[language];

  // Filters
  const [filters, setFilters] = useState<FilterState>({
    searchTerm: '',
    person: null,
    tag: null,
    startDate: '',
    endDate: '',
  });

  // PWA Install Prompt Listener
  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setDeferredPrompt(null);
      }
    }
  };

  // Load photos from Storage Service
  const loadData = async () => {
    const version = ++loadVersion.current;
    photosRef.current = [];
    committedPhotos.current.clear();
    setPhotos([]);
    setSelectedPhoto(null);
    deletedPhotoIds.current.clear();
    replacingPhotoIds.current.clear();
    setIsLoading(true);
    setFamilyTree(null);
    setTreeLoadError(false);
    try {
        // If filesystem, we might not be connected yet (e.g. reload)
        const settings = storageService.getSettings();
        if (settings.storageType === 'filesystem' && !await storageService.restoreFileSystem()) {
            setFsNeeded(true);
            setIsLoading(false);
            return;
        } else {
            setFsNeeded(false);
        }
        const cloudConfig = settings.storageType === 'cloud' ? storageService.cloudConfig() : null;
        if (cloudConfig) {
          const user = await currentFirebaseUser(cloudConfig);
          if (version !== loadVersion.current) return;
          setCloudEmail(user?.email || null);
          if (!user) { setCloudGate('signin'); setIsLoading(false); return; }
        } else setCloudEmail(null);
        setCloudGate(null);

        const [photoResult, treeResult] = await Promise.allSettled([
          storageService.loadPhotos(), storageService.loadFamilyTree(),
        ]);
        if (version !== loadVersion.current) return;
        if (photoResult.status === 'fulfilled') {
          photosRef.current = photoResult.value;
          committedPhotos.current = new Map(photoResult.value.map(photo => [photo.id, photo]));
          setPhotos(photoResult.value);
          void storageService.backfillThumbnails(photoResult.value, prepared => {
            if (version !== loadVersion.current || deletedPhotoIds.current.has(prepared.id)) return;
            setPhotos(current => current.map(photo => photo.id === prepared.id && displaySource(photo) === displaySource(prepared)
              ? { ...photo, thumbnailUrl: prepared.thumbnailUrl, thumbnailSource: prepared.thumbnailSource } : photo));
          }, () => version !== loadVersion.current);
        }
        else {
          setPhotos([]); console.error('Failed to load photos', photoResult.reason);
          if (isPermissionDenied(photoResult.reason)) setCloudGate('denied');
        }
        if (treeResult.status === 'fulfilled') setFamilyTree(treeResult.value);
        else { setTreeLoadError(true); console.error('Failed to load family tree', treeResult.reason); }
    } catch (e) {
        console.error("Failed to load photos", e);
    } finally {
        if (version === loadVersion.current) setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    return () => { ++loadVersion.current; };
  }, []);

  const handleSignIn = async () => {
    const config = storageService.cloudConfig();
    if (!config) return;
    setSignInError(false);
    try { await signInWithGoogle(config); }
    catch (error) { console.error('Sign-in failed', error); setSignInError(true); return; }
    loadData();
  };

  const handleSignOut = async () => {
    const config = storageService.cloudConfig();
    if (config) await signOutOfFirebase(config);
    loadData();
  };

  const handleReconnectDrive = async () => {
      const success = await storageService.reconnectFileSystem();
      if (success) {
          setFsNeeded(false);
          loadData();
      }
  };

  const handleLanguageChange = (lang: Language) => {
      setLanguage(lang);
      const currentSettings = storageService.getSettings();
      storageService.saveSettings({ ...currentSettings, language: lang });
  };

  const handleSettingsClosed = () => {
      setShowSettings(false);
      loadData();
      setLanguage(storageService.getSettings().language);
  };

  const handleFileUpload = async (files: FileList) => {
    if (uploadingRef.current || isLoading || files.length === 0) return;
    const selectedFiles = Array.from(files);
    const automatic = storageService.getSettings().suggestionMode === 'automatic';
    // Lock synchronously so two drop events cannot start competing batches.
    uploadingRef.current = true;
    setIsLoading(true);
    setUploadErrors([]);
    setUploadSummary(null);
    const failures: string[] = [];
    let imported = 0;
    setUploadProgress({ total: selectedFiles.length, completed: 0, saved: 0, failed: 0, currentFile: selectedFiles[0].name, phase: 'reading' });
    try {
      for (const [index, file] of selectedFiles.entries()) {
        let stage: 'conversion' | 'storage' = 'conversion';
        setUploadProgress({ total: selectedFiles.length, completed: index, saved: imported, failed: failures.length, currentFile: file.name, phase: 'reading' });
        try {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          const prepared = await prepareImageUpload(file, phase => setUploadProgress(current => current && ({ ...current, phase })));
          stage = 'storage';
          setUploadProgress(current => current && ({ ...current, phase: 'saving' }));
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          await storageService.savePhoto({
            id: generateId(), originalUrl: prepared.dataUrl, fileName: prepared.fileName,
            uploadDate: Date.now(), description: '', people: [], tags: [], faceTags: [], dateOfPhoto: prepared.dateOfPhoto || '', isRestoring: false,
            ...(automatic ? { autoSuggestions: { faces: true, metadata: true } } : {}),
          });
          imported++;
        } catch (error) {
          console.error('Photo import failed', file.name, error);
          const name = (error as { name?: string })?.name;
          const reason = stage === 'conversion' ? t.uploadConvertFailed
            : name === 'QuotaExceededError' ? t.uploadStorageFull
            : name === 'NotAllowedError' || name === 'SecurityError' ? t.uploadPermissionDenied : t.uploadFailed;
          failures.push(`${file.name}: ${reason}`);
        }
        setUploadProgress(current => current && ({ ...current, completed: index + 1, saved: imported, failed: failures.length }));
      }
      if (imported > 0) {
        setUploadProgress(current => current && ({ ...current, currentFile: '', phase: 'refreshing' }));
        await loadData();
        setViewMode('gallery');
      }
    } finally {
      setUploadErrors(failures);
      setUploadSummary({ saved: imported, failed: failures.length, total: selectedFiles.length });
      setUploadProgress(null);
      setIsLoading(false);
      uploadingRef.current = false;
    }
  };

  const handlePhotoUpdate = async (updated: Photo) => {
    if (deletedPhotoIds.current.has(updated.id) || replacingPhotoIds.current.has(updated.id)) return;
    const previous = photosRef.current.find(photo => photo.id === updated.id);
    const committedBaseline = committedPhotos.current.get(updated.id) || previous;
    const archiveVersion = loadVersion.current;
    if (previous && previous.originalUrl === updated.originalUrl) {
      updated = { ...updated, originalRevision: previous.originalRevision, similarityIndex: previous.similarityIndex };
      const metadataChanged = previous.dateOfPhoto !== updated.dateOfPhoto || previous.location !== updated.location;
      const facesChanged = JSON.stringify(previous.faceTags) !== JSON.stringify(updated.faceTags) || JSON.stringify(previous.people) !== JSON.stringify(updated.people);
      if (updated.autoSuggestions && (metadataChanged || facesChanged)) updated.autoSuggestions = { ...updated.autoSuggestions,
        ...(metadataChanged ? { metadata: false } : {}), ...(facesChanged ? { faces: false } : {}) };
      if (metadataChanged && updated.aiMetadata) {
        updated.aiMetadata = { ...updated.aiMetadata };
        if (previous.dateOfPhoto !== updated.dateOfPhoto) delete updated.aiMetadata.dateOfPhoto;
        if (previous.location !== updated.location) delete updated.aiMetadata.location;
      }
    }
    if (previous && displaySource(previous) !== displaySource(updated)) {
      updated = { ...updated, thumbnailUrl: undefined, thumbnailSource: undefined };
    }
    const version = (photoSaveVersions.current.get(updated.id) || 0) + 1;
    photoSaveVersions.current.set(updated.id, version);
    setPhotoSaveErrors(current => ({ ...current, [updated.id]: false }));
    photosRef.current = photosRef.current.map(p => p.id === updated.id ? updated : p);
    setPhotos(prev => prev.map(p => p.id === updated.id ? updated : p));
    setSelectedPhoto(current => current?.id === updated.id ? updated : current);
    try {
        const saved = await storageService.savePhoto(updated, previous, committedBaseline);
        const sourceIsCurrent = archiveVersion === loadVersion.current && getCurrentPhoto(updated.id)?.originalUrl === updated.originalUrl;
        // A later optimistic edit may already be queued. Keep the last committed
        // baseline current without discarding any unsaved fields from that edit.
        if (saved && sourceIsCurrent) committedPhotos.current.set(updated.id, saved);
        if (sourceIsCurrent && version === photoSaveVersions.current.get(updated.id)) {
          if (saved) {
            photosRef.current = photosRef.current.map(photo => photo.id === updated.id ? saved : photo);
            setPhotos(current => current.map(photo => photo.id === updated.id ? saved : photo));
            setSelectedPhoto(current => current?.id === updated.id ? saved : current);
          }
          setPhotoSaveErrors(current => ({ ...current, [updated.id]: false }));
        }
    } catch (e) {
        console.error("Failed to save update", e);
        if (archiveVersion === loadVersion.current && version === photoSaveVersions.current.get(updated.id) && getCurrentPhoto(updated.id)?.originalUrl === updated.originalUrl) {
          setPhotoSaveErrors(current => ({ ...current, [updated.id]: true }));
        }
    }
  };

  const handleFaceIndexSave = async (source: Photo, index: FaceRecognitionIndex | null) => {
    if (renderedArchiveVersion !== loadVersion.current) throw new Error('Archive changed during recognition');
    const before = getCurrentPhoto(source.id);
    if (!before || before.originalUrl !== source.originalUrl) throw new Error('Photo changed during recognition');
    await storageService.saveFaceRecognition(source, index);
    if (renderedArchiveVersion !== loadVersion.current) return;
    const current = getCurrentPhoto(source.id);
    if (!current || current.originalUrl !== source.originalUrl) return;
    const merge = (photo: Photo): Photo => {
      if (photo.id !== source.id || photo.originalUrl !== source.originalUrl) return photo;
      const next = { ...photo };
      if (index) next.faceRecognition = index; else delete next.faceRecognition;
      return next;
    };
    photosRef.current = photosRef.current.map(merge);
    setPhotos(photos => photos.map(merge));
    setSelectedPhoto(photo => photo ? merge(photo) : photo);
  };

  const handleReplaceOriginal = async (id: string, originalUrl: string) => {
    const archiveVersion = loadVersion.current;
    const current = photosRef.current.find(photo => photo.id === id);
    if (!current || deletedPhotoIds.current.has(id) || replacingPhotoIds.current.has(id)) throw new Error('Photo unavailable');
    replacingPhotoIds.current.add(id);
    setPhotoMutations(count => count + 1);
    const version = (photoSaveVersions.current.get(id) || 0) + 1;
    photoSaveVersions.current.set(id, version);
    // Publish the new image only after it and its metadata have committed.
    try {
      const saved = await storageService.replaceOriginal(current, originalUrl);
      if (archiveVersion === loadVersion.current) committedPhotos.current.set(id, saved);
      photosRef.current = photosRef.current.map(photo => photo.id === id ? saved : photo);
      setPhotoSaveErrors(errors => ({ ...errors, [id]: false }));
      setPhotos(photos => photos.map(photo => photo.id === id ? saved : photo));
      setSelectedPhoto(photo => photo?.id === id ? saved : photo);
      for (const source of [current.originalUrl, current.restoredUrl, current.thumbnailUrl]) {
        if (source?.startsWith('blob:')) URL.revokeObjectURL(source);
      }
    } finally {
      replacingPhotoIds.current.delete(id);
      setPhotoMutations(count => count - 1);
    }
  };

  const handleSimilarityIndexSave = async (source: Photo, index: PhotoSimilarityIndex | null) => {
    if (renderedArchiveVersion !== loadVersion.current) throw new Error('Archive changed during similarity indexing');
    const before = getCurrentPhoto(source.id);
    if (!before || before.originalUrl !== source.originalUrl || similaritySourceRevision(before) !== similaritySourceRevision(source)) throw new Error('Photo changed during similarity indexing');
    await storageService.savePhotoSimilarity(source, index);
    if (renderedArchiveVersion !== loadVersion.current) return;
    const merge = (photo: Photo): Photo => {
      if (photo.id !== source.id || photo.originalUrl !== source.originalUrl || similaritySourceRevision(photo) !== similaritySourceRevision(source) || !getCurrentPhoto(source.id)) return photo;
      const next = { ...photo };
      if (index) next.similarityIndex = index; else delete next.similarityIndex;
      return next;
    };
    photosRef.current = photosRef.current.map(merge);
    setPhotos(photos => photos.map(merge));
    setSelectedPhoto(photo => photo ? merge(photo) : photo);
  };

  const handlePhotoDelete = async (id: string) => {
    const archiveVersion = loadVersion.current;
    if (deletedPhotoIds.current.has(id)) return;
    // Ignore stale editor/AI callbacks while deletion is queued and after it succeeds.
    deletedPhotoIds.current.add(id);
    setPhotoMutations(count => count + 1);
    try {
      await storageService.deletePhoto(id);
      photoSaveVersions.current.delete(id);
      if (archiveVersion === loadVersion.current) committedPhotos.current.delete(id);
      setPhotoSaveErrors(current => ({ ...current, [id]: false }));
      setPhotos(current => current.filter(photo => photo.id !== id));
      setSelectedPhoto(current => current?.id === id ? null : current);
      const removed = photos.find(photo => photo.id === id);
      for (const source of [removed?.originalUrl, removed?.restoredUrl, removed?.thumbnailUrl]) {
        if (source?.startsWith('blob:')) URL.revokeObjectURL(source);
      }
    } catch (error) {
      deletedPhotoIds.current.delete(id);
      throw error;
    } finally { setPhotoMutations(count => count - 1); }
  };
  const handlePhotoClick = (photo: Photo) => {
      // Keep the visible gallery order stable while dates or filtered metadata are edited.
      const sequence = filteredPhotos.map(item => item.id);
      setPhotoSequence(sequence.includes(photo.id) ? sequence : photos.map(item => item.id));
      setSelectedPhoto(photo);
  };

  const filteredPhotos = useMemo(() => {
    let result = photos;

    if (filters.searchTerm) {
      const term = filters.searchTerm.toLowerCase();
      result = result.filter(p => 
        p.description.toLowerCase().includes(term) ||
        collectArchivePeople([p]).some(person => person.toLowerCase().includes(term)) ||
        p.tags.some(tag => tag.toLowerCase().includes(term)) ||
        (p.location && p.location.toLowerCase().includes(term))
      );
    }

    if (filters.person) {
      result = result.filter(p => collectArchivePeople([p]).some(person => personNameKey(person) === personNameKey(filters.person!)));
    }

    if (filters.tag) {
      result = result.filter(p => p.tags.includes(filters.tag!));
    }
    
    const sortedResult = [...result].sort(comparePhotoDates);

    return sortedResult;
  }, [photos, filters]);

  const photosById = useMemo(() => new Map(photos.map(photo => [photo.id, photo])), [photos]);
  const navigationPhotos = photoSequence
    .map(id => photosById.get(id))
    .filter((photo): photo is Photo => Boolean(photo));
  const selectedIndex = navigationPhotos.findIndex(photo => photo.id === selectedPhoto?.id);
  const navigatePhoto = (direction: -1 | 1) => {
    const next = navigationPhotos[selectedIndex + direction];
    if (selectedIndex >= 0 && next) setSelectedPhoto(next);
  };
  const navigation: PhotoNavigationProps = {
    activeEdge: navigationEdge,
    index: selectedIndex,
    total: navigationPhotos.length,
    language,
    onPrevious: () => navigatePhoto(-1),
    onNext: () => navigatePhoto(1),
  };
  const getCurrentPhoto = (id: string) => replacingPhotoIds.current.has(id) || deletedPhotoIds.current.has(id) ? undefined : photosRef.current.find(photo => photo.id === id);

  const uniquePeople = useMemo(() => collectArchivePeople([
    ...photos,
    { people: (familyTree?.people || []).map(person => person.name), faceTags: [] },
  ]), [photos, familyTree]);

  const handleTreeSave = async (next: FamilyTreeData) => {
    setTreeSaving(true);
    try {
      await storageService.saveFamilyTree(next);
      setFamilyTree(next);
    } finally { setTreeSaving(false); }
  };

  const handlePersonSave = async (next: FamilyTreeData, personId: string) => {
    const previous = familyTree?.people.find(person => person.id === personId);
    const updated = next.people.find(person => person.id === personId);
    setTreeSaving(true);
    try {
      await storageService.savePersonDetails(next, personId);
      if (previous && updated && previous.name !== updated.name) {
        setPhotos(current => current.map(photo => renamePhotoPerson(photo, previous.name, updated.name)));
        setSelectedPhoto(current => current && renamePhotoPerson(current, previous.name, updated.name));
        setFilters(current => current.person && personNameKey(current.person) === personNameKey(previous.name) ? { ...current, person: updated.name } : current);
      }
      setFamilyTree(next);
    } finally { setTreeSaving(false); }
  };

  const uniqueTags = useMemo(() => {
    const allTags = photos.flatMap(p => p.tags);
    return Array.from(new Set(allTags)).sort();
  }, [photos]);

  const recognition = useBackgroundFaceRecognition({
    photos,
    enabled: !isLoading && !archiveBlocked && !showSettings && !uploadProgress && photoMutations === 0,
    archiveKey: renderedArchiveVersion,
    priorityPhotoId: selectedPhoto?.id,
    getCurrentPhoto,
    onSaveIndex: handleFaceIndexSave,
  });
  const similarityIndexing = useBackgroundPhotoSimilarity({
    photos,
    enabled: !isLoading && !archiveBlocked && !showSettings && !uploadProgress && photoMutations === 0,
    archiveKey: renderedArchiveVersion,
    priorityPhotoId: selectedPhoto?.id,
    getCurrentPhoto,
    onSaveIndex: handleSimilarityIndexSave,
  });

  const handleAutomaticSuggestions = async (source: Photo, domains: SuggestionDomains, isCurrent: () => boolean) => {
    const archiveVersion = loadVersion.current;
    const valid = () => archiveVersion === loadVersion.current && isCurrent();
    try {
      const result = await storageService.saveAutomaticSuggestions(source, current => applyAutomaticPhotoSuggestions(
        current, photosRef.current, familyTreeRef.current?.people || [], domains,
      ), valid);
      if (!result || archiveVersion !== loadVersion.current) return;
      if (getCurrentPhoto(source.id)?.originalUrl === source.originalUrl) committedPhotos.current.set(source.id, result.photo);
      const merge = (photo: Photo): Photo => {
        if (photo.id !== source.id || photo.originalUrl !== source.originalUrl || !getCurrentPhoto(photo.id)) return photo;
        const next = { ...photo };
        // User edits made during the commit take precedence over this result.
        if (JSON.stringify(photo.faceTags) === JSON.stringify(result.before.faceTags) && JSON.stringify(photo.people) === JSON.stringify(result.before.people)) {
          next.faceTags = result.photo.faceTags;
          next.people = result.photo.people;
        }
        for (const field of ['dateOfPhoto', 'location'] as const) {
          if (photo[field] !== result.before[field]) continue;
          next[field] = result.photo[field];
          next.aiMetadata = { ...next.aiMetadata };
          if (result.photo.aiMetadata?.[field]) next.aiMetadata[field] = result.photo.aiMetadata[field];
          else delete next.aiMetadata[field];
        }
        if (photo.autoSuggestions && result.photo.autoSuggestions) next.autoSuggestions = {
          faces: photo.autoSuggestions.faces && result.photo.autoSuggestions.faces,
          metadata: photo.autoSuggestions.metadata && result.photo.autoSuggestions.metadata,
        };
        return next;
      };
      photosRef.current = photosRef.current.map(merge);
      setPhotos(current => current.map(merge));
      setSelectedPhoto(current => current ? merge(current) : current);
      setPhotoSaveErrors(current => ({ ...current, [source.id]: false }));
    } catch (error) {
      if (archiveVersion === loadVersion.current && getCurrentPhoto(source.id)) setPhotoSaveErrors(current => ({ ...current, [source.id]: true }));
      throw error;
    }
  };
  useAutomaticPhotoSuggestions({
    photos, familyPeople: familyTree?.people || [],
    enabled: storageService.getSettings().suggestionMode === 'automatic' && !isLoading && !archiveBlocked && !showSettings && !uploadProgress && !treeSaving && !treeLoadError && photoMutations === 0,
    archiveKey: renderedArchiveVersion, faceIndexing: recognition, sceneIndexing: similarityIndexing,
    getCurrentPhoto, onApply: handleAutomaticSuggestions,
  });

  const shuffleGallery = () => {
    if (photos.length > 0) {
        const random = photos[Math.floor(Math.random() * photos.length)];
        handlePhotoClick(random);
    }
  };

  return (
    <div className={`${viewMode === 'tree' ? 'flex h-dvh flex-col overflow-hidden' : 'min-h-screen'} bg-slate-900 text-slate-200 font-sans`}>
      {/* App header */}
      <header className="sticky top-0 z-30 shrink-0 bg-slate-900/80 backdrop-blur-md border-b border-slate-800">
        <div className="w-full px-4 sm:px-6 lg:px-8">
          <div className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 py-3 lg:h-16 lg:flex-nowrap lg:py-0">
            <div className="flex shrink-0 items-center gap-2 ftb-brand" data-brand="family-time-box" onClick={() => setViewMode('gallery')}>
              <img src={`${import.meta.env.BASE_URL}brand/family-time-box.svg`} alt="" aria-hidden="true" className="ftb-brand-symbol cursor-pointer" />
              <span className="ftb-brand-wordmark cursor-pointer">{t.appTitle}</span>
            </div>
            
            <nav className="order-last flex w-full items-center justify-end gap-2 lg:order-none lg:ml-auto lg:w-auto" aria-label={t.appTitle}>
              {([
                { mode: 'gallery', label: t.gallery, Icon: LayoutGrid },
                { mode: 'tree', label: t.familyTree, Icon: GitBranch },
              ] as const).map(({ mode, label, Icon }) => (
                <button key={mode} type="button" onClick={() => setViewMode(mode)} aria-current={viewMode === mode ? 'page' : undefined}
                  className={`flex items-center gap-2 rounded-lg border border-transparent px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sepia-400 ${viewMode === mode ? 'bg-slate-700 text-white hover:bg-slate-600' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                  <Icon size={16} aria-hidden="true" />{label}
                </button>
              ))}
            </nav>

            <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-4 lg:ml-0">
               {(isLoading || uploadProgress) && <RefreshCw className="animate-spin text-sepia-400" size={20} />}
               
               <button 
                 onClick={() => setShowSettings(true)}
                 className="p-2 text-slate-400 hover:text-white transition-colors"
                 title={t.settings}
                 disabled={Boolean(uploadProgress) || treeSaving}
               >
                 <Settings size={20} />
               </button>
               <JobsButton language={language} onClick={() => setShowJobs(true)} expanded={showJobs} />
               {cloudEmail && (
                 <button type="button" onClick={handleSignOut} className="p-2 text-slate-400 hover:text-white transition-colors"
                   title={`${t.signOut} (${cloudEmail})`} aria-label={`${t.signOut} (${cloudEmail})`} disabled={Boolean(uploadProgress) || treeSaving}>
                   <LogOut size={20} />
                 </button>
               )}
               <button 
                onClick={shuffleGallery}
                className="p-2 text-slate-400 hover:text-sepia-400 transition-colors hidden sm:block"
                title="View Random Photo"
               >
                 <Shuffle size={20} />
               </button>
               <div className="flex items-center gap-1 sm:gap-4">

                 {/* Install Button (PWA) */}
                 <button 
                   onClick={handleInstallClick}
                   disabled={!deferredPrompt}
                   className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                       deferredPrompt 
                       ? 'bg-slate-800 hover:bg-slate-700 text-sepia-400 border-sepia-900 cursor-pointer' 
                       : 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed opacity-50'
                   }`}
                   title={deferredPrompt ? t.installDesc : "Already installed or not supported"}
                 >
                     <svg viewBox="0 0 88 88" width="16" height="16" fill="currentColor">
                         <path d="M0 12.402l35.687-4.86.016 34.423-35.67.219zm35.67 33.529l.028 34.253L0 74.597V41.31zm4.326-39.02L87.961 0v41.527l-47.965.344zm0 39.513l47.965.419V88l-47.935-6.575z" />
                     </svg>
                     {t.installApp}
                 </button>
               </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className={viewMode === 'tree' ? 'flex min-h-0 flex-1 flex-col' : 'w-full px-4 sm:px-6 lg:px-8 py-8'}>
        
        {uploadProgress && viewMode !== 'upload' && (
          <div className="mb-6 rounded-xl border border-sepia-700/70 bg-slate-800/60 p-5 flex justify-center">
            <UploadProgressPanel progress={uploadProgress} language={language} />
          </div>
        )}
        {uploadSummary && (
          <div role="status" className="mb-6 rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-slate-200">
            {t.uploadComplete} · {t.uploadSaved}: {uploadSummary.saved} / {uploadSummary.total}
            {uploadSummary.failed > 0 && ` · ${t.uploadFailedCount}: ${uploadSummary.failed}`}
          </div>
        )}
        {uploadErrors.length > 0 && (
          <div role="alert" className="mb-6 rounded-xl border border-red-800 bg-red-950/40 p-4 text-red-200">
            {uploadErrors.map((message, index) => <p key={index}>{message}</p>)}
          </div>
        )}
        {/* Drive Reconnection Alert */}
        {fsNeeded && (
            <div className="bg-amber-900/20 border border-amber-700/50 rounded-xl p-6 text-center mb-8 flex flex-col items-center gap-4">
                <div className="bg-amber-900/40 p-3 rounded-full">
                    <AlertTriangle className="text-amber-500" size={32} />
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-amber-200">{t.reconnectDrive}</h3>
                    <p className="text-amber-400/70 text-sm mt-1">{t.reconnectDriveDesc}</p>
                </div>
                <button 
                    onClick={handleReconnectDrive}
                    className="bg-amber-700 hover:bg-amber-600 text-white px-6 py-2 rounded-lg font-medium transition-colors shadow-lg"
                >
                    {t.reconnectDrive}
                </button>
            </div>
        )}

        {cloudGate && (
            <div role={cloudGate === 'denied' ? 'alert' : undefined} className="mx-auto mb-8 flex max-w-lg flex-col items-center gap-4 rounded-xl border border-slate-700 bg-slate-800/60 p-8 text-center">
                <div className="rounded-full bg-slate-900 p-3"><Lock className="text-sepia-400" size={32} aria-hidden="true" /></div>
                <div>
                    <h2 className="text-lg font-semibold text-slate-100">{cloudGate === 'denied' ? t.accessDeniedTitle : t.signInTitle}</h2>
                    <p className="mt-1 text-sm text-slate-400">{cloudGate === 'denied' ? t.accessDeniedDesc : t.signInDesc}</p>
                    {cloudGate === 'denied' && cloudEmail && <p className="mt-2 text-sm text-slate-300">{t.signedInAs} {cloudEmail}</p>}
                </div>
                {cloudGate === 'signin' ? (
                  <button type="button" onClick={handleSignIn} className="flex items-center gap-2 rounded-lg bg-sepia-700 px-6 py-2 font-medium text-white shadow-lg transition-colors hover:bg-sepia-600">
                    <LogIn size={18} aria-hidden="true" />{t.signInButton}
                  </button>
                ) : (
                  <button type="button" onClick={handleSignOut} className="flex items-center gap-2 rounded-lg bg-slate-700 px-6 py-2 font-medium text-white transition-colors hover:bg-slate-600">
                    <LogOut size={18} aria-hidden="true" />{t.signOut}
                  </button>
                )}
                {signInError && <p role="alert" className="text-sm text-red-300">{t.signInFailed}</p>}
            </div>
        )}

        {cloudGate ? null : viewMode === 'tree' ? (
          !archiveBlocked && (treeLoadError ? (
            <div role="alert" className="rounded-xl border border-red-800 bg-red-950/30 p-6 space-y-4">
              <p>{t.treeLoadFailed}</p>
              <button type="button" onClick={loadData} className="rounded-lg bg-slate-700 px-4 py-2">{t.treeRetry}</button>
            </div>
          ) : familyTree ? (
            <FamilyTree tree={familyTree} knownPeople={uniquePeople} photos={photos} language={language} onSave={handleTreeSave} onPersonSave={handlePersonSave} />
          ) : <p role="status" className="py-20 text-center text-slate-400">{t.uploadLoadingArchive}</p>)
        ) : viewMode === 'upload' ? (
          <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-bold text-white">{t.uploadTitle}</h1>
              <p className="text-slate-400">{t.uploadDesc}</p>
            </div>
            <UploadZone onFileSelect={handleFileUpload} language={language} disabled={isLoading || archiveBlocked} progress={uploadProgress} />
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex min-h-[38px] flex-wrap items-center justify-between gap-4">
              <h1 className="text-2xl font-semibold text-white">{t.gallery}</h1>
              <div className="ml-auto flex items-center gap-2 sm:gap-3">
                <button
                  type="button" role="switch" aria-checked={isEditing} aria-label={t.editMode}
                  onClick={() => setIsEditing(current => !current)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${isEditing ? 'border-sepia-500 bg-sepia-600 text-white' : 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700'}`}
                >
                  <Edit3 size={16} aria-hidden="true" />
                  {t.editMode}
                  <span aria-hidden="true" className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 ${isEditing ? 'bg-sepia-900' : 'bg-slate-600'}`}>
                    <span className={`h-4 w-4 rounded-full bg-white transition-transform ${isEditing ? 'translate-x-4' : ''}`} />
                  </span>
                </button>
                 <button 
                  type="button"
                  onClick={() => setViewMode('upload')}
                  aria-label={t.uploadBtn}
                  className="flex min-h-[34px] items-center justify-center gap-2 bg-sepia-600 hover:bg-sepia-500 text-white px-3 py-1.5 rounded-lg text-sm font-medium border border-transparent transition-all shadow-lg shadow-sepia-900/20"
                 >
                   <PlusCircle size={16} aria-hidden="true" />
                   <span className="hidden sm:inline">{t.uploadBtn}</span>
                 </button>
              </div>
            </div>
            {/* Filter Bar */}
            <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50 backdrop-blur-sm flex flex-col md:flex-row gap-4 items-center justify-between sticky top-[7.5rem] lg:top-20 z-20 shadow-xl">
              <div className="relative w-full md:w-96">
                <Search className="absolute left-3 top-2.5 text-slate-500" size={18} />
                <input 
                  type="text" 
                  placeholder={t.searchPlaceholder}
                  value={filters.searchTerm}
                  onChange={(e) => setFilters(prev => ({...prev, searchTerm: e.target.value}))}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-sepia-500 focus:outline-none placeholder-slate-600"
                />
              </div>

              <div className="flex items-center gap-3 w-full md:w-auto overflow-x-auto pb-2 md:pb-0 no-scrollbar">
                {/* Person Filter */}
                <div className="relative group">
                    <select 
                        className="appearance-none bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm text-slate-300 pr-8 focus:outline-none focus:border-sepia-500 min-w-[140px]"
                        value={filters.person || ''}
                        onChange={(e) => setFilters(prev => ({...prev, person: e.target.value || null}))}
                    >
                        <option value="">{t.allPeople}</option>
                        {uniquePeople.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <Users size={14} className="absolute right-3 top-3 text-slate-500 pointer-events-none" />
                </div>

                {/* Tag Filter */}
                <div className="relative group">
                    <select 
                        className="appearance-none bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm text-slate-300 pr-8 focus:outline-none focus:border-sepia-500 min-w-[140px]"
                        value={filters.tag || ''}
                        onChange={(e) => setFilters(prev => ({...prev, tag: e.target.value || null}))}
                    >
                        <option value="">{t.allTags}</option>
                        {uniqueTags.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <Filter size={14} className="absolute right-3 top-3 text-slate-500 pointer-events-none" />
                </div>
              </div>
            </div>

            {/* Gallery Grid */}
            {!archiveBlocked && filteredPhotos.length === 0 ? (
                <div className="text-center py-20 opacity-50">
                    <p className="text-xl">{t.noPhotos}</p>
                    <button onClick={() => setViewMode('upload')} className="mt-4 text-sepia-400 hover:underline">{t.uploadSome}</button>
                </div>
            ) : (
                <PhotoGallery
                  key={JSON.stringify(filters)}
                  photos={filteredPhotos}
                  onPhotoClick={handlePhotoClick}
                  language={language}
                />
            )}
          </div>
        )}
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal 
            currentLanguage={language}
            onLanguageChange={handleLanguageChange}
            onClose={handleSettingsClosed}
        />
      )}

      {/* Viewing / Editing Modals */}
      {selectedPhoto && (
          <>
            {isEditing ? (
                <PhotoEditor
                    key={selectedPhoto.id}
                    photo={selectedPhoto}
                    language={language}
                    onClose={() => setSelectedPhoto(null)} 
                    onUpdate={handlePhotoUpdate}
                    onDelete={handlePhotoDelete}
                    onReplaceOriginal={handleReplaceOriginal}
                    archivePhotos={photos}
                    familyPeople={familyTree?.people || []}
                    recognition={recognition}
                    onShowJobs={() => setShowJobs(true)}
                    jobsOpen={showJobs}
                    onSimilarityJobChange={setSimilarityJob}
                    knownPeople={uniquePeople}
                    descriptionPeople={familyTree?.people || []}
                    saveError={photoSaveErrors[selectedPhoto.id] ? t.photoSaveFailed : null}
                    navigation={navigation}
                    onView={() => setIsEditing(false)}
                    getCurrentPhoto={getCurrentPhoto}
                />
            ) : (
                <PhotoPresentation
                    key={selectedPhoto.id}
                    photo={selectedPhoto}
                    language={language}
                    onClose={() => setSelectedPhoto(null)}
                    onEdit={() => setIsEditing(true)}
                    navigation={navigation}
                />
            )}
          </>
      )}
      {showJobs && <JobsPopup language={language} recognition={recognition} similarity={similarityJob} similarityIndexing={similarityIndexing}
        waitingForArchive={isLoading || archiveBlocked} onClose={() => setShowJobs(false)} />}
    </div>
  );
};

export default App;
