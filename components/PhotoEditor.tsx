import React, { useState, useRef, useEffect, MouseEvent } from 'react';
import { Photo, FaceTag, Language, FamilyTreePerson } from '../types';
import { translations } from '../utils/translations';
import { X, Tag, Wand2, ArrowLeftRight, Download, Eye, RotateCcw, MousePointer2, Loader2, MapPin, Trash2, Upload } from 'lucide-react';
import * as GeminiService from '../services/geminiService';
import { PersonPicker } from './PersonPicker';
import { PhotoNavigation, type PhotoNavigationProps } from './PhotoNavigation';
import { PhotoDateField } from './PhotoDateField';
import { PhotoMetadataSuggestions } from './PhotoMetadataSuggestions';
import { JobsButton, type PhotoSimilarityJob } from './JobsPopup';
import { canonicalPersonName, personNameKey, getPhotoDescriptionPeople } from '../utils/people';
import { detectFaces, hasFaceTag, type DetectedFace } from '../services/faceDetection';
import { prepareImageUpload } from '../utils/imageUpload';
import type { useBackgroundFaceRecognition } from '../hooks/useBackgroundFaceRecognition';
import { buildFaceReferences, suggestFace, validFaceIndex } from '../utils/faceMatching';
import { SFACE_MODEL_ID } from '../services/faceRecognition';
import { AiSuggestionBadge, isAiMetadata, isAiPerson, hasAiSuggestions } from './AiSuggestionBadge';
import { aiSuggestionTranslations } from '../utils/aiSuggestionTranslations';

interface PhotoEditorProps {
  photo: Photo;
  language: Language;
  onClose: () => void;
  onView: () => void;
  navigation: PhotoNavigationProps;
  getCurrentPhoto: (id: string) => Photo | undefined;
  knownPeople: string[];
  archivePhotos: Photo[];
  familyPeople: FamilyTreePerson[];
  recognition: ReturnType<typeof useBackgroundFaceRecognition>;
  onShowJobs: () => void;
  jobsOpen: boolean;
  onSimilarityJobChange: (job: PhotoSimilarityJob | null) => void;
  descriptionPeople?: Pick<FamilyTreePerson, 'name' | 'descriptionName'>[];
  saveError?: string | null;
  onUpdate: (updatedPhoto: Photo) => void;
  onDelete: (id: string) => Promise<void>;
  onReplaceOriginal: (id: string, originalUrl: string) => Promise<void>;
}

export const PhotoEditor: React.FC<PhotoEditorProps> = ({ photo, language, onClose, onUpdate, onDelete, onReplaceOriginal, knownPeople, descriptionPeople = [], saveError, navigation, onView, getCurrentPhoto, archivePhotos, familyPeople, recognition, onShowJobs, jobsOpen, onSimilarityJobChange }) => {
  const [viewOriginal, setViewOriginal] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletingRef = useRef(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceSuccess, setReplaceSuccess] = useState(false);
  const replacingRef = useRef(false);
  const replacementInputRef = useRef<HTMLInputElement>(null);
  const [isTaggingMode, setIsTaggingMode] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [detectedFaces, setDetectedFaces] = useState<DetectedFace[]>([]);
  const [dismissedFaces, setDismissedFaces] = useState<string[]>([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectionPhase, setDetectionPhase] = useState<'loading' | 'detecting'>('loading');
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [pendingTag, setPendingTag] = useState<{x: number, y: number, detectionId?: string} | null>(null);
  
  const imageRef = useRef<HTMLImageElement>(null);

  const t = translations[language];
  const ai = aiSuggestionTranslations[language];
  const recognitionResult = validFaceIndex(photo.faceRecognition, SFACE_MODEL_ID) ? photo.faceRecognition : null;
  const isRecognizingThisPhoto = recognition.running && recognition.currentPhotoId === photo.id;

  // Input states for adding new items via sidebar
  const [newTag, setNewTag] = useState('');

  const handleRestore = async () => {
    // Set loading state
    onUpdate({ ...photo, isRestoring: true });

    try {
      const restoredBase64 = await GeminiService.restorePhoto(photo.originalUrl);
      const current = getCurrentPhoto(photo.id);
      if (!current || current.originalUrl !== photo.originalUrl) return;
      const updated = {
        ...current,
        restoredUrl: restoredBase64,
        isRestoring: false 
      };
      onUpdate(updated);
      setViewOriginal(false); // Switch to restored view
    } catch (err) {
      console.error("Restoration error", err);
      // Revert loading state
      const current = getCurrentPhoto(photo.id);
      if (!current || current.originalUrl !== photo.originalUrl) return;
      onUpdate({ ...current, isRestoring: false });
      alert(GeminiService.getGeminiErrorMessage(err, language));
    }
  };

  const handleAutoAnalyze = async () => {
     setIsAnalyzing(true);
     try {
         const analysis = await GeminiService.analyzePhoto(
             photo.originalUrl, 
             photo.faceTags,
             photo.dateOfPhoto,
             photo.location,
             language,
             getPhotoDescriptionPeople(photo, descriptionPeople)
         );
         
         // Use safe checks
         if (!analysis || (!analysis.description && (!analysis.tags || analysis.tags.length === 0))) {
             throw new Error("No analysis data returned");
         }

         const current = getCurrentPhoto(photo.id);
         if (!current || current.originalUrl !== photo.originalUrl) return;
         const currentTags = current.tags || [];
         const newTags = analysis.tags || [];
         const updated = {
             ...current,
             description: current.description === photo.description ? (analysis.description || current.description) : current.description, 
             location: current.location === photo.location ? (analysis.location || current.location) : current.location,
             tags: [...new Set([...currentTags, ...newTags])]
         };
         onUpdate(updated);
         
     } catch (err) {
         console.error("Analysis failed", err);
         alert(GeminiService.getGeminiErrorMessage(err, language));
     } finally {
         setIsAnalyzing(false);
     }
  };

  const handleReplaceOriginal = async (file?: File) => {
    if (!file || replacingRef.current || deletingRef.current || photo.isRestoring || isAnalyzing) return;
    if (!window.confirm(t.replaceOriginalConfirm.replace('{fileName}', photo.fileName))) return;
    replacingRef.current = true;
    setIsReplacing(true);
    setReplaceError(null);
    setReplaceSuccess(false);
    setPendingTag(null);
    setIsTaggingMode(false);
    try {
      const prepared = await prepareImageUpload(file);
      // Validate ordinary images too before replacing a working original.
      const image = new Image();
      image.src = prepared.dataUrl;
      await image.decode();
      await onReplaceOriginal(photo.id, prepared.dataUrl);
      setViewOriginal(true);
      setReplaceSuccess(true);
    } catch (error) {
      console.error('Could not replace the original photo.', error);
      setReplaceError(t.replaceOriginalFailed);
    } finally {
      replacingRef.current = false;
      setIsReplacing(false);
    }
  };

  const handleDelete = async () => {
    if (deletingRef.current || photo.isRestoring || isAnalyzing) return;
    if (!window.confirm(t.deletePhotoConfirm.replace('{fileName}', photo.fileName))) return;
    deletingRef.current = true;
    setIsDeleting(true);
    setDeleteError(null);
    setPendingTag(null);
    setIsTaggingMode(false);
    try {
      await onDelete(photo.id);
    } catch (error) {
      console.error('Could not delete the photo from the archive.', error);
      setDeleteError(t.photoDeleteFailed);
    } finally {
      deletingRef.current = false;
      setIsDeleting(false);
    }
  };
  // --- Spatial Tagging Logic ---

  const handleImageClick = (event: MouseEvent<HTMLDivElement>) => {
    // Controls and tag labels must never start another face tag through bubbling.
    if (isDeleting || isReplacing || !isTaggingMode || !imageRef.current || event.target !== imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    setPendingTag({
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
    });
  };

  const saveFaceTag = (value: string, point: { x: number; y: number }, personId?: string) => {
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    const currentPeople = current.people || [];
    const name = canonicalPersonName(value, [...currentPeople, ...knownPeople]);
    if (!name) return;
    const linkedPerson = familyPeople.find(person => person.id === personId) || familyPeople.find(person => personNameKey(person.name) === personNameKey(name));
    const tag: FaceTag = { id: crypto.randomUUID(), name, x: point.x, y: point.y, ...(linkedPerson ? { personId: linkedPerson.id } : {}) };
    onUpdate({ ...current, ...(current.autoSuggestions ? { autoSuggestions: { ...current.autoSuggestions, faces: false } } : {}), faceTags: [...(current.faceTags || []), tag],
      people: currentPeople.some(person => personNameKey(person) === personNameKey(name)) ? currentPeople : [...currentPeople, name] });
    setPendingTag(null);
  };
  const confirmPendingTag = (value: string) => {
    if (pendingTag) saveFaceTag(value, pendingTag);
  };
  const removeFaceTag = (id: string) => {
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    const removed = (current.faceTags || []).find(tag => tag.id === id);
    const faceTags = (current.faceTags || []).filter(tag => tag.id !== id);
    onUpdate({ ...current, faceTags,
      ...(removed?.aiSuggested && removed.aiAddedPerson && !faceTags.some(tag => personNameKey(tag.name) === personNameKey(removed.name))
        ? { people: current.people.filter(name => personNameKey(name) !== personNameKey(removed.name)) } : {}),
      ...(current.autoSuggestions ? { autoSuggestions: { ...current.autoSuggestions, faces: false } } : {}) });
  };

  const confirmAiName = (name: string) => {
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    onUpdate({ ...current,
      faceTags: current.faceTags.map(tag => {
        if (personNameKey(tag.name) !== personNameKey(name)) return tag;
        const confirmed = { ...tag }; delete confirmed.aiSuggested; delete confirmed.aiAddedPerson; return confirmed;
      }),
      ...(current.autoSuggestions ? { autoSuggestions: { ...current.autoSuggestions, faces: false } } : {}) });
  };

  const confirmAiMetadata = (field: 'dateOfPhoto' | 'location') => {
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    const aiMetadata = { ...current.aiMetadata }; delete aiMetadata[field];
    onUpdate({ ...current, aiMetadata,
      ...(current.autoSuggestions ? { autoSuggestions: { ...current.autoSuggestions, metadata: false } } : {}) });
  };

  // --- Sidebar Logic ---

  const addPerson = (value: string) => {
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    const currentPeople = current.people || [];
    const name = canonicalPersonName(value, [...currentPeople, ...knownPeople]);
    if (!name || currentPeople.some(person => personNameKey(person) === personNameKey(name))) return;
    onUpdate({ ...current, people: [...currentPeople, name],
      ...(current.autoSuggestions ? { autoSuggestions: { ...current.autoSuggestions, faces: false } } : {}) });
  };

  const addTag = () => {
    if (!newTag.trim()) return;
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    const currentTags = current.tags || [];
    if (currentTags.includes(newTag.trim())) return;

    const updated = { ...current, tags: [...currentTags, newTag.trim()] };
    onUpdate(updated);
    setNewTag('');
  };

  const removePerson = (p: string) => {
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    const currentPeople = current.people || [];
    const updated = { ...current, people: currentPeople.filter(person => personNameKey(person) !== personNameKey(p)),
      faceTags: (current.faceTags || []).filter(tag => personNameKey(tag.name) !== personNameKey(p)),
      ...(current.autoSuggestions ? { autoSuggestions: { ...current.autoSuggestions, faces: false } } : {}) };
    onUpdate(updated);
  };

  const removeTag = (t: string) => {
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    const currentTags = current.tags || [];
    const updated = { ...current, tags: currentTags.filter(x => x !== t) };
    onUpdate(updated);
  };

  const updateField = (field: keyof Photo, value: any) => {
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    const updated = { ...current, [field]: value };
    if (field === 'dateOfPhoto' || field === 'location') {
      updated.aiMetadata = { ...current.aiMetadata };
      delete updated.aiMetadata[field];
      if (current.autoSuggestions) updated.autoSuggestions = { ...current.autoSuggestions, metadata: false };
    }
    onUpdate(updated);
  };

  const activeImage = (viewOriginal || !photo.restoredUrl) ? photo.originalUrl : photo.restoredUrl;
  const visibleFaces = recognitionResult && activeImage === photo.originalUrl ? recognitionResult.faces : detectedFaces;
  const unassignedFaces = visibleFaces.filter(face => !dismissedFaces.includes(face.id) && !hasFaceTag(face, photo.faceTags || []));
  const faceReferences = buildFaceReferences(archivePhotos, familyPeople, SFACE_MODEL_ID, photo.id);
  const faceSuggestions = recognitionResult?.faces.filter(face => !dismissedFaces.includes(face.id) && !hasFaceTag(face, photo.faceTags || [])).map(face => ({ face, match: suggestFace(face, faceReferences) })) || [];
  const hasFaceData = archivePhotos.some(item => Boolean(item.faceRecognition));

  useEffect(() => { setPendingTag(null); setDismissedFaces([]); }, [activeImage, photo.id, recognitionResult]);

  useEffect(() => {
    if (!isTaggingMode || isRecognizingThisPhoto || (recognitionResult && activeImage === photo.originalUrl)) {
      setDetectedFaces([]);
      setIsDetecting(false);
      setDetectionFailed(false);
      return;
    }
    const controller = new AbortController();
    setDetectedFaces([]);
    setIsDetecting(true);
    setDetectionPhase('loading');
    setDetectionFailed(false);
    detectFaces(activeImage, { signal: controller.signal, onProgress: phase => {
      if (!controller.signal.aborted) setDetectionPhase(phase);
    } }).then(faces => {
      if (!controller.signal.aborted) setDetectedFaces(faces);
    }).catch(error => {
      if (!controller.signal.aborted) {
        console.warn('Face detection unavailable; manual tagging is still available.', error);
        setDetectionFailed(true);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setIsDetecting(false);
    });
    return () => controller.abort();
  }, [isTaggingMode, activeImage, photo.id, isRecognizingThisPhoto, recognitionResult]);

  return (
    <div role="dialog" aria-modal="true" aria-label={t.photoDetails} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm animate-in fade-in duration-200">
      <PhotoNavigation {...navigation} disabled={isDeleting || isReplacing} />
      <div className="bg-slate-900 w-full max-w-6xl h-[90vh] rounded-2xl flex flex-col md:flex-row overflow-y-auto md:overflow-hidden border border-slate-700 shadow-2xl">
        <fieldset disabled={isDeleting || isReplacing} className="contents" aria-busy={isDeleting || isReplacing}>
        
        {/* Left: Image View */}
        <div className="relative min-h-[35vh] shrink-0 md:shrink md:min-h-0 md:flex-1 bg-black flex items-center justify-center overflow-hidden bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZD0iTTEgMWgydjJIMUMxeiIgZmlsbD0iIzMzMyIgZmlsbC1vcGFjaXR5PSIwLjEiLz48L3N2Zz4=')]">
            
            {/* Image Wrapper for relative positioning of tags */}
            <div 
                className={`relative inline-block max-w-full max-h-full ${isTaggingMode ? 'cursor-crosshair' : ''}`}
                onClick={handleImageClick}
            >
                <img 
                    ref={imageRef}
                    src={activeImage} 
                    className="max-w-full max-h-[45vh] md:max-h-[85vh] object-contain shadow-2xl" 
                    alt="Main view"
                />

                {(isTaggingMode || (recognitionResult && activeImage === photo.originalUrl)) && unassignedFaces.map((face, index) => (
                  <button
                    key={face.id} type="button" aria-label={`${t.detectedFace} ${index + 1}`}
                    onClick={event => {
                      event.stopPropagation();
                      setPendingTag({ x: face.x + face.width / 2, y: face.y + face.height / 2, detectionId: face.id });
                    }}
                    className={`absolute z-10 rounded border-2 bg-cyan-400/5 hover:bg-cyan-400/20 focus:outline-none focus:ring-2 focus:ring-white ${pendingTag?.detectionId === face.id ? 'border-white' : 'border-cyan-400'}`}
                    style={{ left: `${face.x}%`, top: `${face.y}%`, width: `${face.width}%`, height: `${face.height}%` }}
                  >
                    <span aria-hidden="true" className="absolute -top-5 left-0 rounded bg-slate-900/90 px-1 text-xs text-cyan-200">{index + 1}</span>
                  </button>
                ))}
                {/* Render Existing Face Tags */}
                {(photo.faceTags || []).map(tag => (
                    <div 
                        key={tag.id}
                        className="absolute w-0 h-0 group"
                        style={{ left: `${tag.x}%`, top: `${tag.y}%` }}
                    >
                         {/* Marker */}
                         <div className={`absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 border-2 rounded-full shadow-lg cursor-pointer hover:scale-125 transition-transform ${tag.aiSuggested ? 'bg-violet-500/60 border-dashed border-violet-200' : 'bg-sepia-500/50 border-white'}`} />
                         
                         {/* Label */}
                         <div className={`absolute top-4 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded whitespace-nowrap transition-opacity flex items-center gap-2 pointer-events-auto ${tag.aiSuggested ? 'opacity-100 border border-dashed border-violet-400' : 'opacity-0 group-hover:opacity-100'}`}>
                            {tag.name}
                            {tag.aiSuggested && <AiSuggestionBadge language={language} compact />}
                            <button aria-label={`${ai.removeFace}: ${tag.name}`} type="button" onClick={(e) => { e.stopPropagation(); removeFaceTag(tag.id); }} className="hover:text-red-400">
                                <X size={10} />
                            </button>
                         </div>
                    </div>
                ))}

                {pendingTag && <div aria-hidden="true" className="absolute z-20 w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white border-2 border-sepia-500" style={{ left: `${pendingTag.x}%`, top: `${pendingTag.y}%` }} />}
            </div>

            {pendingTag && (
              <div className="absolute z-40 bottom-24 left-4 right-4 mx-auto max-w-sm rounded-xl border border-slate-600 bg-slate-800 p-3 shadow-xl" onClick={event => event.stopPropagation()}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-white">{t.whoIsThis}</p>
                  <button type="button" onClick={() => setPendingTag(null)} aria-label={t.cancelTag} className="rounded p-1 text-slate-300 hover:text-white"><X size={16} /></button>
                </div>
                <PersonPicker key={`${pendingTag.x}-${pendingTag.y}`} knownPeople={knownPeople} language={language} label={t.whoIsThis} submitLabel={t.tagPerson} onSelect={confirmPendingTag} autoFocus direction="up" />
                {pendingTag.detectionId && <button type="button" className="mt-2 text-xs text-slate-400 hover:text-white" onClick={() => {
                  setDismissedFaces(ids => [...ids, pendingTag.detectionId!]);
                  setPendingTag(null);
                }}>{t.dismissFaceBox}</button>}
              </div>
            )}
            {/* Image Controls */}
            <div className="absolute bottom-6 flex gap-4 bg-slate-900/80 p-2 rounded-full border border-slate-700 backdrop-blur z-30">
                <button 
                    onClick={() => {
                        setIsTaggingMode(!isTaggingMode);
                        setPendingTag(null);
                    }}
                    className={`p-2 rounded-full transition-colors flex items-center gap-2 ${isTaggingMode ? 'bg-sepia-600 text-white' : 'hover:bg-slate-700 text-white'}`}
                    title={t.tagPeopleBtn}
                    aria-label={t.tagPeopleBtn}
                    aria-pressed={isTaggingMode}
                >
                    <MousePointer2 size={20} />
                    {isTaggingMode && <span className="text-xs font-bold pr-2">{t.clickFace}</span>}
                </button>

                <div className="w-px h-6 bg-slate-700 my-auto mx-1" />

                {photo.restoredUrl && (
                    <button 
                        onClick={() => setViewOriginal(!viewOriginal)}
                        className="p-2 hover:bg-slate-700 rounded-full text-white transition-colors tooltip-trigger"
                        title={t.toggleOriginal}
                        type="button"
                    >
                        <ArrowLeftRight size={20} />
                    </button>
                )}
                <a 
                    href={activeImage} 
                    download={`family-time-box-${photo.id}.png`}
                    className="p-2 hover:bg-slate-700 rounded-full text-white transition-colors"
                    title={t.download}
                >
                    <Download size={20} />
                </a>
            </div>

            {photo.restoredUrl && (
                <div className="absolute top-6 left-6 bg-black/60 px-3 py-1 rounded text-white text-sm font-medium border border-white/20 z-10">
                    {viewOriginal ? t.originalScan : t.restoredByAi}
                </div>
            )}
            
            {isTaggingMode && !isRecognizingThisPhoto && (
              <div role="status" aria-live="polite" className="absolute top-4 left-4 right-4 z-30 mx-auto max-w-md rounded-lg border border-slate-600 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 pointer-events-none">
                {isDetecting ? (
                  <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin shrink-0" />{detectionPhase === 'loading' ? t.faceDetectionLoading : t.faceDetectionRunning}</span>
                ) : detectionFailed ? t.faceDetectionFailed
                  : visibleFaces.length === 0 ? t.noFacesDetected
                  : unassignedFaces.length > 0 ? `${t.facesToName} ${unassignedFaces.length}. ${t.faceDetectionChoose}`
                  : t.detectedFacesNamed}
              </div>
            )}
        </div>
        {/* Right: Controls & Metadata */}
        <div className="w-full md:w-[400px] shrink-0 bg-slate-800 p-4 sm:p-6 md:overflow-y-auto flex flex-col gap-6 border-l border-slate-700">
            <div className="space-y-3">
              <div className="flex justify-between items-center gap-2">
                <h2 className="text-xl font-semibold text-white">{t.photoDetails}</h2>
                <div className="flex items-center gap-1">
                  <JobsButton language={language} onClick={onShowJobs} expanded={jobsOpen} />
                  <button onClick={onView} type="button" className="rounded-lg px-3 py-2 text-sm text-sepia-300 hover:bg-slate-700">{t.viewMode}</button>
                  <button onClick={onClose} aria-label={t.close} type="button" className="p-2 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition-colors">
                    <X size={24} />
                  </button>
                </div>
              </div>
            </div>

            {saveError && <p role="alert" className="rounded-lg border border-red-700 bg-red-950/50 p-3 text-sm text-red-200">{saveError}</p>}

            {deleteError && <p role="alert" className="rounded-lg border border-red-700 bg-red-950/50 p-3 text-sm text-red-200">{deleteError}</p>}

            {replaceError && <p role="alert" className="rounded-lg border border-red-700 bg-red-950/50 p-3 text-sm text-red-200">{replaceError}</p>}

            {replaceSuccess && <p role="status" className="rounded-lg border border-sepia-700 bg-sepia-900/30 p-3 text-sm text-sepia-100">{t.replaceOriginalSuccess}</p>}

            {/* Actions */}
            <div className="grid grid-cols-2 gap-3">
                 <button 
                    onClick={handleRestore}
                    disabled={photo.isRestoring}
                    type="button"
                    className={`flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-medium transition-all ${
                        photo.isRestoring 
                        ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                        : 'bg-gradient-to-r from-sepia-500 to-sepia-600 text-white hover:from-sepia-400 hover:to-sepia-500 shadow-lg shadow-sepia-900/20'
                    }`}
                >
                    {photo.isRestoring ? <RotateCcw className="animate-spin" size={18} /> : <Wand2 size={18} />}
                    {photo.restoredUrl ? t.reRestoreBtn : t.restoreBtn}
                </button>
                 <button 
                    onClick={handleAutoAnalyze}
                    disabled={isAnalyzing}
                    type="button"
                    className={`flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-medium border transition-all ${
                        isAnalyzing
                        ? 'bg-slate-700 text-slate-400 border-slate-600 cursor-wait'
                        : 'bg-slate-700 text-slate-200 hover:bg-slate-600 border-slate-600'
                    }`}
                >
                    {isAnalyzing ? <Loader2 className="animate-spin" size={18} /> : <Eye size={18} />}
                    {isAnalyzing ? t.analyzing : t.analyzeBtn}
                </button>
            </div>

            <section aria-label={t.faceRecognition} className="space-y-3 rounded-xl border border-slate-600 bg-slate-900/40 p-3">
              <h3 className="text-sm font-semibold text-white">{t.faceRecognition}</h3>
              <p className="text-xs text-slate-300">{t.recognitionHelp}</p>
              <p className="text-xs text-slate-400">{t.recognitionStorage}</p>
              <div className="flex items-center justify-between gap-2">
                <button type="button" disabled={recognition.clearing} onClick={recognition.paused ? recognition.resume : recognition.pause} className="shrink-0 text-xs text-sepia-200 underline disabled:opacity-50">{recognition.paused ? t.resumeRecognition : t.pauseRecognition}</button>
              </div>
              {recognitionResult && <>
                <p role="status" className="text-xs text-slate-300">{!faceReferences.length ? t.recognitionNoReferences : !faceSuggestions.some(item => item.match) ? t.recognitionNoMatches : t.recognitionReview}</p>
                {faceSuggestions.map(({ face, match }, index) => <div key={face.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-800 p-2 text-xs">
                  <button type="button" className="text-left text-cyan-200 hover:underline" onClick={() => {
                    setViewOriginal(true); setIsTaggingMode(true); setPendingTag({ x: face.x + face.width / 2, y: face.y + face.height / 2, detectionId: face.id });
                  }}>{t.detectedFace} {index + 1}{match ? ` · ${match.name}` : ` · ${t.recognitionUnknown}`}</button>
                  {match && <button type="button" aria-label={`${t.confirmRecognition}: ${match.name}`} className="shrink-0 rounded bg-sepia-700 px-2 py-1 text-white hover:bg-sepia-600" onClick={() => {
                    const current = getCurrentPhoto(photo.id);
                    if (current && !hasFaceTag(face, current.faceTags || [])) { setViewOriginal(true); setIsTaggingMode(true); saveFaceTag(match.name, { x: face.x + face.width / 2, y: face.y + face.height / 2 }, match.personId); }
                  }}>{t.confirmRecognition}</button>}
                </div>)}
              </>}
              {hasFaceData && <button type="button" disabled={recognition.clearing} onClick={() => { void recognition.clear(); }} className="text-xs text-slate-400 underline hover:text-white disabled:opacity-50">{t.clearFaceData}</button>}
            </section>

            <div className="space-y-2">
              <input
                ref={replacementInputRef} type="file" accept="image/*,.tif,.tiff,image/tiff,image/x-tiff"
                aria-label={t.replaceOriginal} className="hidden" disabled={photo.isRestoring || isAnalyzing}
                onChange={event => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  void handleReplaceOriginal(file);
                }}
              />
              <button
                type="button" onClick={() => replacementInputRef.current?.click()}
                disabled={photo.isRestoring || isAnalyzing}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isReplacing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                {isReplacing ? t.replacingOriginal : t.replaceOriginal}
              </button>
              <p className="text-xs text-slate-400">{t.replaceOriginalHint}</p>
              {isReplacing && <p role="status" className="text-sm text-sepia-200">{t.replacingOriginal}</p>}
            </div>

            <div className="space-y-2">
              <button
                type="button" onClick={handleDelete} disabled={isDeleting || photo.isRestoring || isAnalyzing}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-800/70 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-950/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                {isDeleting ? t.deletingPhoto : t.deletePhoto}
              </button>
              {(photo.isRestoring || isAnalyzing) && <p className="text-xs text-slate-400">{t.deleteWaitForAI}</p>}
            </div>
            <hr className="border-slate-700" />

            {hasAiSuggestions(photo) && <p className="rounded-lg border border-dashed border-violet-500/70 bg-violet-950/30 p-3 text-xs leading-relaxed text-violet-200">{ai.reviewHelp}</p>}

            {/* Date */}
            <div className={isAiMetadata(photo, 'dateOfPhoto') ? 'space-y-3 rounded-lg border border-dashed border-violet-500 bg-violet-950/20 p-3' : 'space-y-2'}>
              <PhotoDateField key={photo.id} value={photo.dateOfPhoto} language={language} onChange={date => updateField('dateOfPhoto', date)} />
              {isAiMetadata(photo, 'dateOfPhoto') && <div className="flex flex-wrap items-center justify-between gap-2"><AiSuggestionBadge language={language} /><button type="button" aria-label={ai.confirmDate} onClick={() => confirmAiMetadata('dateOfPhoto')} className="text-xs text-violet-200 underline hover:text-white">{ai.confirmDate}</button></div>}
            </div>

            {/* Location */}
            <div className={isAiMetadata(photo, 'location') ? 'space-y-3 rounded-lg border border-dashed border-violet-500 bg-violet-950/20 p-3' : 'space-y-2'}>
                <label className="text-xs uppercase tracking-wider text-slate-500 font-bold">{t.location}</label>
                <div className="relative">
                    <MapPin className="absolute left-3 top-2.5 text-slate-400 pointer-events-none" size={16} />
                    <input 
                        type="text" 
                        value={photo.location || ''}
                        onChange={(e) => updateField('location', e.target.value)}
                        aria-label={t.location}
                        placeholder="e.g. Grandma's Garden, Paris"
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 pl-10 pr-3 text-sm text-slate-200 focus:ring-2 focus:ring-sepia-500 focus:outline-none placeholder-slate-500"
                    />
                </div>
                {isAiMetadata(photo, 'location') && <div className="flex flex-wrap items-center justify-between gap-2"><AiSuggestionBadge language={language} /><button type="button" aria-label={ai.confirmPlace} onClick={() => confirmAiMetadata('location')} className="text-xs text-violet-200 underline hover:text-white">{ai.confirmPlace}</button></div>}
            </div>

            <PhotoMetadataSuggestions
              photo={photo}
              archivePhotos={archivePhotos}
              language={language}
              disabled={isDeleting || isReplacing || photo.isRestoring || isAnalyzing}
              getCurrentPhoto={getCurrentPhoto}
              onJobChange={onSimilarityJobChange}
              onApply={(field, value) => {
                const current = getCurrentPhoto(photo.id);
                if (current && current.originalUrl === photo.originalUrl && !deletingRef.current && !replacingRef.current) {
                  updateField(field, value);
                }
              }}
            />

            {/* Description */}
            <div className="space-y-2">
                <label className="text-xs uppercase tracking-wider text-slate-500 font-bold">{t.description}</label>
                <textarea 
                    value={photo.description}
                    onChange={(e) => updateField('description', e.target.value)}
                    placeholder={language === 'en' ? "Grandma's 60th birthday at the lake house..." : "Babičkina 60-tka na chate..."}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 focus:ring-2 focus:ring-sepia-500 focus:outline-none min-h-[100px] resize-none"
                />
            </div>

            {/* People */}
            <div className="space-y-2">
                <label className="text-xs uppercase tracking-wider text-slate-500 font-bold">{t.people}</label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {(photo.people || []).map(p => (
                        <span key={p} className={`px-2 py-1 rounded text-xs flex flex-wrap items-center gap-1 ${isAiPerson(photo, p) ? 'border border-dashed border-violet-400 bg-violet-950/40 text-violet-100' : 'bg-slate-700 text-slate-200'}`}>
                            {p}
                            {isAiPerson(photo, p) && <><AiSuggestionBadge language={language} compact /><button type="button" aria-label={`${ai.confirmName}: ${p}`} onClick={() => confirmAiName(p)} className="ml-1 text-violet-200 underline hover:text-white">{ai.confirmName}</button></>}
                            <button aria-label={`${t.removePerson}: ${p}`} onClick={() => removePerson(p)} className="hover:text-red-400" type="button"><X size={12}/></button>
                        </span>
                    ))}
                </div>
                <PersonPicker knownPeople={knownPeople} excludedPeople={photo.people || []} language={language} onSelect={addPerson} />
                <p className="text-xs text-slate-400">{t.choosePersonHint}</p>
            </div>
            {/* Tags */}
            <div className="space-y-2">
                <label className="text-xs uppercase tracking-wider text-slate-500 font-bold">{t.tags}</label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {(photo.tags || []).map(t => (
                        <span key={t} className="bg-sepia-900/30 border border-sepia-800 text-sepia-300 px-2 py-1 rounded text-xs flex items-center gap-1">
                            #{t}
                            <button onClick={() => removeTag(t)} className="hover:text-red-400" type="button"><X size={12}/></button>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input 
                        type="text" 
                        value={newTag}
                        onChange={(e) => setNewTag(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addTag()}
                        placeholder={t.addTagPlaceholder}
                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:ring-2 focus:ring-sepia-500 focus:outline-none"
                    />
                    <button onClick={addTag} className="bg-slate-700 hover:bg-slate-600 p-2 rounded-lg text-slate-300" type="button">
                        <Tag size={18} />
                    </button>
                </div>
            </div>
        </div>
        </fieldset>
      </div>
    </div>
  );
};
