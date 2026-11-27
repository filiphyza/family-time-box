
import { Photo, AppSettings, FirebaseConfig, FamilyTreeData, FaceRecognitionIndex, PhotoSimilarityIndex } from '../types';
import { emptyFamilyTree, validateFamilyTree, FamilyTreeError } from '../utils/familyTree';
import { createThumbnail, displaySource, hasThumbnail, thumbnailSource } from '../utils/thumbnails';
import { collectArchivePeople, personNameKey, renamePhotoPerson } from '../utils/people';
import { BrowserPhotoStorage } from './browserPhotoStorage';
import { loadArchiveHandle, saveArchiveHandle, type ArchiveDirectoryHandle } from './archiveFolder';
import { firebaseAppFor, hostedFirebaseConfig, currentFirebaseUser } from './firebaseApp';
import { getFirestore, collection, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, writeBatch, deleteField, runTransaction } from 'firebase/firestore';
import { getStorage, ref, uploadString, getDownloadURL, deleteObject, listAll } from 'firebase/storage';


const SETTINGS_KEY = 'ancestry-lens-settings';
const DB_FILENAME = 'ancestry_db.json';
const FAMILY_TREE_FILENAME = 'ancestry_family_tree.json';

// --- Interfaces ---

interface StorageAdapter {
  loadFamilyTree(): Promise<FamilyTreeData>;
  saveFamilyTree(tree: FamilyTreeData): Promise<void>;
  loadPhotos(): Promise<Photo[]>;
  savePhoto(photo: Photo, replaceOriginal?: boolean): Promise<void>;
  saveThumbnail(photo: Photo): Promise<void>;
  saveFaceRecognition(id: string, index: FaceRecognitionIndex | null): Promise<void>;
  savePhotoSimilarity(id: string, index: PhotoSimilarityIndex | null, originalRevision?: string): Promise<void>;
  savePhotoPeople(changes: Pick<Photo, 'id' | 'people' | 'faceTags'>[]): Promise<void>;
  deletePhoto(id: string): Promise<void>;
  init?(): Promise<boolean>; // For explicit initialization (like folder picking)
}

// --- Helper for Base64 <-> Blob ---

const base64ToBlob = async (base64: string): Promise<Blob> => {
  const response = await fetch(base64);
  return response.blob();
};

const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// --- File System Adapter (Native Local) ---

class FileSystemAdapter implements StorageAdapter {
  async loadFamilyTree(): Promise<FamilyTreeData> {
    if (!this.dirHandle) throw new Error('FileSystem not initialized');
    let handle: FileSystemFileHandle;
    try { handle = await this.dirHandle.getFileHandle(FAMILY_TREE_FILENAME); }
    catch (error) {
      if ((error as DOMException)?.name === 'NotFoundError') return emptyFamilyTree();
      throw error;
    }
    const value = await (await handle.getFile()).text();
    // Empty or invalid existing files are errors, not permission to overwrite them.
    return validateFamilyTree(JSON.parse(value));
  }

  async saveFamilyTree(tree: FamilyTreeData): Promise<void> {
    if (!this.dirHandle) throw new Error('FileSystem not initialized');
    const value = validateFamilyTree(tree);
    const handle = await this.dirHandle.getFileHandle(FAMILY_TREE_FILENAME, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(JSON.stringify(value, null, 2)); await writable.close(); }
    catch (error) { try { await writable.abort(); } catch {} throw error; }
  }
  private dirHandle: ArchiveDirectoryHandle | null = null;
  private imagesHandle: FileSystemDirectoryHandle | null = null;
  private savedHandle: ArchiveDirectoryHandle | undefined;
  private restorePromise?: Promise<boolean>;

  public isConnected(): boolean {
    return !!this.dirHandle && !!this.imagesHandle;
  }

  private async attach(handle: ArchiveDirectoryHandle): Promise<void> {
    const images = await handle.getDirectoryHandle('images', { create: true });
    // Set connected state only after verifying access to the archive itself.
    this.imagesHandle = images;
    this.dirHandle = handle;
    this.savedHandle = handle;
  }

  async init(): Promise<boolean> {
    try {
      // Explicit folder selection in Settings can replace the remembered archive.
      // @ts-ignore - picker is not yet declared in all DOM typings
      const handle: ArchiveDirectoryHandle = await window.showDirectoryPicker({
        id: 'ancestry-lens-root', mode: 'readwrite',
      });
      await this.attach(handle);
      try { await saveArchiveHandle(handle); }
      catch (error) { console.warn('Could not remember the archive folder for next time.', error); }
      return true;
    } catch (error) {
      console.error('File System Access denied or failed', error);
      return false;
    }
  }

  async restore(): Promise<boolean> {
    if (this.isConnected()) return true;
    if (!this.restorePromise) {
      this.restorePromise = this.restoreSaved().finally(() => { this.restorePromise = undefined; });
    }
    return this.restorePromise;
  }

  private async restoreSaved(): Promise<boolean> {
    try {
      this.savedHandle ??= await loadArchiveHandle();
      if (!this.savedHandle) return false;
      // Startup must never prompt: permission requests require a user gesture.
      if (await this.savedHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') return false;
      await this.attach(this.savedHandle);
      return true;
    } catch (error) {
      console.warn('The saved archive folder needs reconnecting.', error);
      return false;
    }
  }

  async reconnect(): Promise<boolean> {
    if (this.isConnected()) return true;
    // restore() preloads this handle before the reconnect button is displayed.
    if (!this.savedHandle) return this.init();
    try {
      let permission = await this.savedHandle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') permission = await this.savedHandle.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') return false;
      await this.attach(this.savedHandle);
      return true;
    } catch (error) {
      console.warn('Could not reconnect the saved archive folder. Select it again in Settings.', error);
      return false;
    }
  }

  async loadPhotos(): Promise<Photo[]> {
    if (!this.dirHandle) throw new Error("FileSystem not initialized");
    
    try {
        // Read DB file
        const fileHandle = await this.dirHandle.getFileHandle(DB_FILENAME, { create: true });
        const file = await fileHandle.getFile();
        const text = await file.text();
        
        let photos: Photo[] = [];
        try {
            if (text.trim()) photos = JSON.parse(text);
        } catch {
            photos = [];
        }

        // Hydrate blobs
        // The DB stores 'images/id_original.png'. We need to convert that to a Blob URL for the session.
        const hydratedPhotos = await Promise.all(photos.map(async (p) => {
            const copy = { ...p };
            try {
                if (p.originalUrl && !p.originalUrl.startsWith('data:') && !p.originalUrl.startsWith('blob:')) {
                    const filename = p.originalUrl.split('/').pop();
                    if (filename) {
                        const imgHandle = await this.imagesHandle.getFileHandle(filename);
                        const imgFile = await imgHandle.getFile();
                        copy.originalUrl = URL.createObjectURL(imgFile);
                    }
                }
                if (p.restoredUrl && !p.restoredUrl.startsWith('data:') && !p.restoredUrl.startsWith('blob:')) {
                    const filename = p.restoredUrl.split('/').pop();
                    if (filename) {
                         const imgHandle = await this.imagesHandle.getFileHandle(filename);
                         const imgFile = await imgHandle.getFile();
                         copy.restoredUrl = URL.createObjectURL(imgFile);
                    }
                }
            } catch (e) {
                console.warn(`Failed to load image file for ${p.id}`, e);
            }
            if (p.thumbnailUrl && !p.thumbnailUrl.startsWith('data:') && !p.thumbnailUrl.startsWith('blob:')) {
                try {
                    const handle = await this.imagesHandle.getFileHandle(p.thumbnailUrl.split('/').pop()!);
                    copy.thumbnailUrl = URL.createObjectURL(await handle.getFile());
                } catch {
                    delete copy.thumbnailUrl;
                    delete copy.thumbnailSource;
                }
            }
            return copy;
        }));

        return hydratedPhotos.sort((a, b) => (b.uploadDate || 0) - (a.uploadDate || 0));

    } catch (e) {
        console.error("Failed to load DB from file system", e);
        return [];
    }
  }

  async savePhoto(photo: Photo, replaceOriginal = false): Promise<void> {
      if (!this.dirHandle) throw new Error("FileSystem not initialized");

      // 1. Load current DB state (raw paths)
      let currentPhotos: Photo[] = [];
      try {
        const fileHandle = await this.dirHandle.getFileHandle(DB_FILENAME, { create: true });
        const file = await fileHandle.getFile();
        const text = await file.text();
        if (text.trim()) currentPhotos = JSON.parse(text);
      } catch (error) { if (replaceOriginal) throw error; }

      if (replaceOriginal && !currentPhotos.some(item => item.id === photo.id)) {
        throw new Error('The photo is no longer in this archive.');
      }

      // 2. Save Images as Files
      const photoToSave = { ...photo };
      // Stage replacement files so a failed database write preserves the old images.
      const revision = replaceOriginal ? crypto.randomUUID() : null;

      // Helper to write file
      const saveImageFile = async (dataUrlOrBlob: string, suffix: string): Promise<string> => {
        if (dataUrlOrBlob.startsWith('data:')) {
            const blob = await base64ToBlob(dataUrlOrBlob);
            const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : blob.type === 'image/gif' ? 'gif' : 'png';
            const filename = `${photo.id}_${suffix}${revision ? `_${revision}` : ''}.${extension}`;
            const fileHandle = await this.imagesHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            try { await writable.write(blob); await writable.close(); }
            catch (error) { try { await writable.abort(); } catch {} throw error; }
            return `images/${filename}`;
        }
        // If it's a blob url, we probably already saved it or just loaded it. 
        // If it's "images/...", it's already a path.
        // For simple update logic (editing metadata), we want to keep the existing path if it was already a path.
        
        // Find existing record to see if we have a path
        const existing = currentPhotos.find(p => p.id === photo.id);
        if (existing && suffix === 'original' && existing.originalUrl.startsWith('images/')) return existing.originalUrl;
        if (existing && suffix === 'restored' && existing.restoredUrl?.startsWith('images/')) return existing.restoredUrl;
        if (existing && suffix === 'thumbnail' && existing.thumbnailUrl?.startsWith('images/')) return existing.thumbnailUrl;
        
        // Fallback: If it is a new blob url but we don't have the data, this logic is tricky without re-fetching blob.
        // But in this app, if we have a blob URL, we can fetch it.
        if (dataUrlOrBlob.startsWith('blob:')) {
             const blob = await (await fetch(dataUrlOrBlob)).blob();
             const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : blob.type === 'image/gif' ? 'gif' : 'png';
            const filename = `${photo.id}_${suffix}.${extension}`;
             const fileHandle = await this.imagesHandle.getFileHandle(filename, { create: true });
             const writable = await fileHandle.createWritable();
             await writable.write(blob);
             await writable.close();
             return `images/${filename}`;
        }

        return dataUrlOrBlob;
      };

      if (photo.originalUrl) {
          photoToSave.originalUrl = await saveImageFile(photo.originalUrl, 'original');
      }
      if (photo.restoredUrl) {
          photoToSave.restoredUrl = await saveImageFile(photo.restoredUrl, 'restored');
      }

      if (photo.thumbnailUrl) {
          photoToSave.thumbnailUrl = await saveImageFile(photo.thumbnailUrl, 'thumbnail');
      }

      // 3. Update DB Array
      const index = currentPhotos.findIndex(p => p.id === photo.id);
      if (index >= 0) {
        currentPhotos[index] = photoToSave;
      } else {
        currentPhotos.unshift(photoToSave);
      }

      // 4. Write DB
      const dbHandle = await this.dirHandle.getFileHandle(DB_FILENAME, { create: true });
      const writable = await dbHandle.createWritable();
      try { await writable.write(JSON.stringify(currentPhotos, null, 2)); await writable.close(); }
      catch (error) { try { await writable.abort(); } catch {} throw error; }
  }

  async savePhotoPeople(changes: Pick<Photo, 'id' | 'people' | 'faceTags'>[]): Promise<void> {
    if (!changes.length) return;
    if (!this.dirHandle) throw new Error('FileSystem not initialized');
    const handle = await this.dirHandle.getFileHandle(DB_FILENAME);
    const photos: Photo[] = JSON.parse(await (await handle.getFile()).text());
    for (const change of changes) {
      const photo = photos.find(item => item.id === change.id);
      if (!photo) throw new Error('A photo is no longer in this archive.');
      photo.people = change.people; photo.faceTags = change.faceTags;
    }
    const writer = await handle.createWritable();
    try { await writer.write(JSON.stringify(photos, null, 2)); await writer.close(); }
    catch (error) { try { await writer.abort(); } catch {} throw error; }
  }

  async saveFaceRecognition(id: string, index: FaceRecognitionIndex | null): Promise<void> {
    if (!this.dirHandle) throw new Error('FileSystem not initialized');
    const handle = await this.dirHandle.getFileHandle(DB_FILENAME);
    const photos: Photo[] = JSON.parse(await (await handle.getFile()).text());
    const photo = photos.find(item => item.id === id);
    if (!photo) throw new Error('The photo is no longer in this archive.');
    if (index === null) delete photo.faceRecognition;
    else photo.faceRecognition = index;
    const writer = await handle.createWritable();
    try { await writer.write(JSON.stringify(photos, null, 2)); await writer.close(); }
    catch (error) { try { await writer.abort(); } catch {} throw error; }
  }

  async savePhotoSimilarity(id: string, index: PhotoSimilarityIndex | null, originalRevision?: string): Promise<void> {
    if (!this.dirHandle) throw new Error('FileSystem not initialized');
    const handle = await this.dirHandle.getFileHandle(DB_FILENAME);
    const photos: Photo[] = JSON.parse(await (await handle.getFile()).text());
    const photo = photos.find(item => item.id === id);
    if (!photo) throw new Error('The photo is no longer in this archive.');
    if (originalRevision !== undefined && (photo.originalRevision || 'legacy-v1') !== originalRevision) {
      throw new Error('The original photo changed while indexing similarity.');
    }
    if (index === null) delete photo.similarityIndex;
    else photo.similarityIndex = index;
    const writer = await handle.createWritable();
    try { await writer.write(JSON.stringify(photos, null, 2)); await writer.close(); }
    catch (error) { try { await writer.abort(); } catch {} throw error; }
  }

  async saveThumbnail(photo: Photo): Promise<void> {
    if (!this.dirHandle || !this.imagesHandle || !photo.thumbnailUrl) throw new Error('FileSystem not initialized');
    const dbHandle = await this.dirHandle.getFileHandle(DB_FILENAME);
    const photos: Photo[] = JSON.parse(await (await dbHandle.getFile()).text());
    const existing = photos.find(item => item.id === photo.id);
    if (!existing) return;
    const blob = await base64ToBlob(photo.thumbnailUrl);
    const extension = blob.type === 'image/webp' ? 'webp' : 'png';
    const filename = `${photo.id}_thumbnail.${extension}`;
    const fileHandle = await this.imagesHandle.getFileHandle(filename, { create: true });
    const imageWriter = await fileHandle.createWritable();
    await imageWriter.write(blob);
    await imageWriter.close();
    existing.thumbnailUrl = `images/${filename}`;
    existing.thumbnailSource = photo.thumbnailSource;
    const writer = await dbHandle.createWritable();
    await writer.write(JSON.stringify(photos, null, 2));
    await writer.close();
  }

  async deletePhoto(id: string): Promise<void> {
     if (!this.dirHandle) throw new Error("FileSystem not initialized");
     
     // Remove from DB file
     // (Optional: Remove image files. Skipping for safety in this demo)
     
     let currentPhotos: Photo[] = [];
     const dbHandle = await this.dirHandle.getFileHandle(DB_FILENAME, { create: true });
     const file = await dbHandle.getFile();
     const text = await file.text();
     if (text.trim()) currentPhotos = JSON.parse(text);

     const filtered = currentPhotos.filter(p => p.id !== id);
     
     const writable = await dbHandle.createWritable();
     await writable.write(JSON.stringify(filtered, null, 2));
     await writable.close();
  }
}

// --- Cloud (Firebase) Adapter ---

class CloudStorageAdapter implements StorageAdapter {
  async loadFamilyTree(): Promise<FamilyTreeData> {
    if (!this.initialized) throw new Error('Cloud storage is not initialized');
    const snapshot = await getDoc(doc(this.db, 'archive', 'familyTree'));
    return snapshot.exists() ? validateFamilyTree(snapshot.data()) : emptyFamilyTree();
  }

  async saveFamilyTree(tree: FamilyTreeData): Promise<void> {
    if (!this.initialized) throw new Error('Cloud storage is not initialized');
    await setDoc(doc(this.db, 'archive', 'familyTree'), validateFamilyTree(tree));
  }
  private db: any;
  private storage: any;
  private initialized = false;

  constructor(config: FirebaseConfig) {
    try {
      const app = firebaseAppFor(config);
      this.db = getFirestore(app);
      this.storage = getStorage(app);
      this.initialized = true;
    } catch (e) {
      console.error("Firebase init failed:", e);
      throw e;
    }
  }

  async loadPhotos(): Promise<Photo[]> {
    if (!this.initialized) return [];
    try {
      const querySnapshot = await getDocs(collection(this.db, "photos"));
      const photos: Photo[] = [];
      querySnapshot.forEach((doc: any) => {
        photos.push(doc.data() as Photo);
      });
      // Sort by date desc
      return photos.sort((a, b) => (b.uploadDate || 0) - (a.uploadDate || 0));
    } catch (e) {
      console.error("Error loading from cloud:", e);
      throw e;
    }
  }

  async savePhoto(photo: Photo, replaceOriginal = false): Promise<void> {
    if (!this.initialized) return;

    const photoToSave = { ...photo };
    // Keep committed cloud objects untouched until the new record is saved.
    const revision = replaceOriginal ? `-${crypto.randomUUID()}` : '';

    try {
      // 1. Handle Original URL (if it's base64)
      if (photo.originalUrl.startsWith('data:')) {
        const storageRef = ref(this.storage, `photos/${photo.id}/original${revision}`);
        await uploadString(storageRef, photo.originalUrl, 'data_url');
        photoToSave.originalUrl = await getDownloadURL(storageRef);
      }

      // 2. Handle Restored URL (if it's base64)
      if (photo.restoredUrl && photo.restoredUrl.startsWith('data:')) {
        const storageRef = ref(this.storage, `photos/${photo.id}/restored`);
        await uploadString(storageRef, photo.restoredUrl, 'data_url');
        photoToSave.restoredUrl = await getDownloadURL(storageRef);
      }

      if (photo.thumbnailUrl?.startsWith('data:')) {
        const thumbnailRef = ref(this.storage, `photos/${photo.id}/thumbnail${revision}`);
        await uploadString(thumbnailRef, photo.thumbnailUrl, 'data_url');
        photoToSave.thumbnailUrl = await getDownloadURL(thumbnailRef);
      }

      // 3. Save Metadata to Firestore
      await setDoc(doc(this.db, "photos", photo.id), photoToSave);

    } catch (e) {
      console.error("Error saving to cloud:", e);
      throw e;
    }
  }

  async savePhotoPeople(changes: Pick<Photo, 'id' | 'people' | 'faceTags'>[]): Promise<void> {
    if (!this.initialized) throw new Error('Cloud storage is not initialized.');
    for (let index = 0; index < changes.length; index += 450) {
      const batch = writeBatch(this.db);
      for (const change of changes.slice(index, index + 450)) batch.update(doc(this.db, 'photos', change.id), { people: change.people, faceTags: change.faceTags });
      await batch.commit();
    }
  }

  async saveFaceRecognition(id: string, index: FaceRecognitionIndex | null): Promise<void> {
    if (!this.initialized) throw new Error('Cloud storage is not initialized');
    // updateDoc fails for a removed record, and preserves all other metadata.
    await updateDoc(doc(this.db, 'photos', id), {
      faceRecognition: index === null ? deleteField() : index,
    });
  }

  async savePhotoSimilarity(id: string, index: PhotoSimilarityIndex | null, originalRevision?: string): Promise<void> {
    if (!this.initialized) throw new Error('Cloud storage is not initialized');
    const reference = doc(this.db, 'photos', id);
    await runTransaction(this.db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error('The photo is no longer in this archive.');
      if (originalRevision !== undefined && (snapshot.data().originalRevision || 'legacy-v1') !== originalRevision) {
        throw new Error('The original photo changed while indexing similarity.');
      }
      // Transactional field updates preserve edits and cannot recreate removed records.
      transaction.update(reference, { similarityIndex: index === null ? deleteField() : index });
    });
  }

  async saveThumbnail(photo: Photo): Promise<void> {
    if (!this.initialized || !photo.thumbnailUrl) throw new Error('Cloud storage is not initialized');
    const thumbnailRef = ref(this.storage, `photos/${photo.id}/thumbnail`);
    await uploadString(thumbnailRef, photo.thumbnailUrl, 'data_url');
    await updateDoc(doc(this.db, 'photos', photo.id), {
      thumbnailUrl: await getDownloadURL(thumbnailRef), thumbnailSource: photo.thumbnailSource,
    });
  }

  async deletePhoto(id: string): Promise<void> {
    if (!this.initialized) return;
    try {
        await deleteDoc(doc(this.db, "photos", id));
        // Remove the image files too; leftover files would keep using storage quota.
        try {
          const files = await listAll(ref(this.storage, `photos/${id}`));
          await Promise.all(files.items.map(item => deleteObject(item)));
        } catch (cleanupError) { console.warn('Could not remove cloud image files for a deleted photo.', cleanupError); }
    } catch(e) {
        console.error("Error deleting from cloud", e);
        throw e;
    }
  }
}

// --- Service Facade ---

class StorageService {
  private writeQueue: Promise<void> = Promise.resolve();
  private recognitionGeneration = 0;
  private thumbnailCaches = new WeakMap<StorageAdapter, Map<string, { source: string; photo: Photo }>>();

  private thumbnailCache(adapter: StorageAdapter) {
    let cache = this.thumbnailCaches.get(adapter);
    if (!cache) { cache = new Map(); this.thumbnailCaches.set(adapter, cache); }
    return cache;
  }

  private async prepareThumbnail(photo: Photo, adapter: StorageAdapter): Promise<Photo> {
    const source = displaySource(photo);
    const cached = this.thumbnailCache(adapter).get(photo.id);
    if (cached?.source === source && hasThumbnail(cached.photo)) {
      return { ...photo, thumbnailUrl: cached.photo.thumbnailUrl, thumbnailSource: cached.photo.thumbnailSource };
    }
    if (!cached && hasThumbnail(photo)) return photo;
    // A failed preview must never prevent importing or editing the original.
    const result = { ...photo };
    delete result.thumbnailUrl;
    delete result.thumbnailSource;
    try {
      result.thumbnailUrl = await createThumbnail(source);
      result.thumbnailSource = thumbnailSource(photo);
    } catch (error) { console.warn(`Could not create thumbnail for ${photo.id}`, error); }
    return result;
  }
  private adapter: StorageAdapter;
  private settings: AppSettings;
  private fileSystemAdapter: FileSystemAdapter; // Keep instance to persist handle in memory

  constructor() {
    this.settings = this.loadSettings();
    this.fileSystemAdapter = new FileSystemAdapter();
    this.adapter = this.createAdapter();
  }

  private loadSettings(): AppSettings {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
    const oldLang = localStorage.getItem('ancestry-lens-lang');
    return {
      language: (oldLang as any) || 'en',
      // The hosted family archive opens in cloud mode; other builds stay local-first.
      storageType: hostedFirebaseConfig ? 'cloud' : 'local'
    };
  }

  private createAdapter(): StorageAdapter {
    const firebaseConfig = this.cloudConfig();
    if (this.settings.storageType === 'cloud' && firebaseConfig) {
      try {
        return new CloudStorageAdapter(firebaseConfig);
      } catch (e) {
        return new BrowserPhotoStorage();
      }
    } else if (this.settings.storageType === 'filesystem') {
        return this.fileSystemAdapter;
    }
    return new BrowserPhotoStorage();
  }

  /** Config saved in Settings, otherwise the one built into the hosted site. */
  public cloudConfig(): FirebaseConfig | null {
    return this.settings.firebaseConfig?.apiKey ? this.settings.firebaseConfig : hostedFirebaseConfig;
  }

  /** In cloud mode, whether someone is signed in (Firestore/Storage rules require it). */
  public async hasCloudUser(): Promise<boolean> {
    const config = this.cloudConfig();
    return !!config && !!await currentFirebaseUser(config);
  }

  public getSettings(): AppSettings {
    return this.settings;
  }

  public saveSettings(settings: AppSettings): void {
    const storageChanged = this.settings.storageType !== settings.storageType ||
      JSON.stringify(this.settings.firebaseConfig || null) !== JSON.stringify(settings.firebaseConfig || null);
    this.settings = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    // A language preference does not change archive ownership or invalidate a scan.
    if (storageChanged) {
      ++this.recognitionGeneration;
      this.adapter = this.createAdapter();
    }
  }

  // Specific method to trigger Directory Picker (must be called from UI event)
  public async connectFileSystem(): Promise<boolean> {
    if (this.settings.storageType !== 'filesystem') return false;
    ++this.recognitionGeneration;
    this.thumbnailCaches.delete(this.fileSystemAdapter);
    try { return await this.fileSystemAdapter.init(); }
    finally {
      // The adapter is reused across folders. Invalidate work queued both before
      // and during the picker, even when the next archive reuses photo IDs.
      ++this.recognitionGeneration;
      this.thumbnailCaches.delete(this.fileSystemAdapter);
    }
  }

  public async restoreFileSystem(): Promise<boolean> {
    return this.settings.storageType === 'filesystem' && await this.fileSystemAdapter.restore();
  }

  public async reconnectFileSystem(): Promise<boolean> {
    if (this.settings.storageType !== 'filesystem') return false;
    if (this.fileSystemAdapter.isConnected()) return true;
    ++this.recognitionGeneration;
    this.thumbnailCaches.delete(this.fileSystemAdapter);
    try { return await this.fileSystemAdapter.reconnect(); }
    finally {
      ++this.recognitionGeneration;
      this.thumbnailCaches.delete(this.fileSystemAdapter);
    }
  }
  public isFileSystemConnected(): boolean {
      return this.fileSystemAdapter.isConnected();
  }

  public async loadFamilyTree(): Promise<FamilyTreeData> {
    const adapter = this.adapter;
    await this.writeQueue;
    return adapter.loadFamilyTree();
  }

  public async saveFamilyTree(tree: FamilyTreeData): Promise<void> {
    const adapter = this.adapter;
    const value = validateFamilyTree(tree);
    const write = this.writeQueue.then(() => adapter.saveFamilyTree(value));
    this.writeQueue = write.catch(() => {});
    return write;
  }

  public async savePersonDetails(tree: FamilyTreeData, personId: string): Promise<void> {
    const adapter = this.adapter;
    const next = validateFamilyTree(tree);
    const updated = next.people.find(person => person.id === personId);
    if (!updated) throw new FamilyTreeError('invalidTarget');
    const write = this.writeQueue.then(async () => {
      const previous = (await adapter.loadFamilyTree()).people.find(person => person.id === personId);
      if (!previous) throw new FamilyTreeError('invalidTarget');
      if (previous.name === updated.name) { await adapter.saveFamilyTree(next); return; }
      const photos = await adapter.loadPhotos();
      try {
        const oldKey = personNameKey(previous.name), newKey = personNameKey(updated.name);
        if (oldKey !== newKey && collectArchivePeople(photos).some(name => personNameKey(name) === newKey)) throw new FamilyTreeError('duplicateName');
        const originals = photos.filter(photo => collectArchivePeople([photo]).some(name => personNameKey(name) === oldKey));
        const renamed = originals.map(photo => renamePhotoPerson(photo, previous.name, updated.name));
        try {
          await adapter.savePhotoPeople(renamed);
          await adapter.saveFamilyTree(next);
        } catch (error) {
          // Keep the old shared name if either the photo metadata or the tree cannot commit.
          try { await adapter.savePhotoPeople(originals); }
          catch (rollbackError) { throw new AggregateError([error, rollbackError], 'The person could not be saved and some photo tags could not be restored.'); }
          throw error;
        }
        const cache = this.thumbnailCache(adapter);
        for (const [id, entry] of cache) cache.set(id, { ...entry, photo: renamePhotoPerson(entry.photo, previous.name, updated.name) });
      } finally {
        // Native reads create temporary session URLs; only metadata was needed here.
        if (adapter instanceof FileSystemAdapter) for (const photo of photos) for (const url of [photo.originalUrl, photo.restoredUrl, photo.thumbnailUrl]) if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      }
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  public async loadPhotos(): Promise<Photo[]> {
    const adapter = this.adapter;
    const generation = this.recognitionGeneration;
    // A read includes asynchronous image hydration. Queue the entire read and
    // cache update so a concurrent index write cannot be replaced by old data.
    const read = this.writeQueue.then(async () => {
      if (adapter !== this.adapter || generation !== this.recognitionGeneration) throw new Error('The archive changed while loading photos.');
      const photos = await adapter.loadPhotos();
      if (adapter !== this.adapter || generation !== this.recognitionGeneration) throw new Error('The archive changed while loading photos.');
      const cache = this.thumbnailCache(adapter);
      cache.clear();
      for (const photo of photos) cache.set(photo.id, { source: displaySource(photo), photo });
      return photos;
    });
    this.writeQueue = read.then(() => {}, () => {});
    return read;
  }

  public async savePhoto(photo: Photo, baseline?: Photo, committedBaseline?: Photo): Promise<Photo> {
    const adapter = this.adapter;
    const write = this.writeQueue.then(async () => {
      // Recognition is patched independently. A metadata edit queued during a
      // scan must neither erase a new index nor resurrect one that was cleared.
      const cached = this.thumbnailCache(adapter).get(photo.id)?.photo;
      let current = { ...photo };
      if (baseline && cached && cached.originalUrl === photo.originalUrl && baseline.originalUrl === photo.originalUrl) {
        // Compare both the previous optimistic view and last successful save:
        // this retains failed edits and explicit reverts, while an unrelated
        // automatic assignment may have committed while this write was queued.
        const same = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
        const committed = committedBaseline?.originalUrl === photo.originalUrl ? committedBaseline : baseline;
        current = { ...cached };
        for (const field of new Set([...Object.keys(baseline), ...Object.keys(committed), ...Object.keys(photo)])) {
          if (same(photo[field], baseline[field]) && same(photo[field], committed[field])) continue;
          if (field === 'autoSuggestions' || field === 'aiMetadata') {
            const merged = { ...cached[field] };
            for (const key of new Set([...Object.keys(baseline[field] || {}), ...Object.keys(committed[field] || {}), ...Object.keys(photo[field] || {})])) {
              if (same(photo[field]?.[key], baseline[field]?.[key]) && same(photo[field]?.[key], committed[field]?.[key])) continue;
              if (photo[field]?.[key] === undefined) delete merged[key]; else merged[key] = photo[field][key];
            }
            current[field] = merged as any;
          } else if (photo[field] === undefined) delete current[field]; else current[field] = photo[field];
        }
        // A user can type the same value that AI assigned during the queued
        // save. Their explicit edit still confirms that field's provenance.
        for (const field of ['dateOfPhoto', 'location'] as const) if ((photo[field] !== baseline[field] || photo[field] !== committed[field]) && current.aiMetadata?.[field]) {
          current.aiMetadata = { ...current.aiMetadata };
          delete current.aiMetadata[field];
        }
      }
      if (cached && cached.originalUrl === photo.originalUrl) {
        current.originalRevision = cached.originalRevision || 'legacy-v1';
        if (cached.faceRecognition) current.faceRecognition = cached.faceRecognition;
        else delete current.faceRecognition;
        if (cached.similarityIndex) current.similarityIndex = cached.similarityIndex;
        else delete current.similarityIndex;
      } else {
        current.originalRevision = crypto.randomUUID();
        delete current.similarityIndex;
      }
      const prepared = await this.prepareThumbnail(current, adapter);
      await adapter.savePhoto(prepared);
      this.thumbnailCache(adapter).set(photo.id, { source: displaySource(photo), photo: prepared });
      return prepared;
    });
    this.writeQueue = write.then(() => {}, () => {});
    return write;
  }

  /** A metadata-only transform runs against the latest committed record. */
  public async saveAutomaticSuggestions(
    source: Photo, transform: (photo: Photo) => Photo, isCurrent: () => boolean,
  ): Promise<{ before: Photo; photo: Photo } | null> {
    const adapter = this.adapter;
    const generation = this.recognitionGeneration;
    const write = this.writeQueue.then(async () => {
      const valid = () => adapter === this.adapter && generation === this.recognitionGeneration && isCurrent();
      if (!valid()) return null;
      const cache = this.thumbnailCache(adapter);
      const entry = cache.get(source.id);
      if (!entry || entry.photo.originalUrl !== source.originalUrl ||
          (entry.photo.originalRevision || 'legacy-v1') !== (source.originalRevision || 'legacy-v1')) return null;
      const before = entry.photo;
      const next = transform(before);
      if (!valid()) return null;
      if (next !== before) await adapter.savePhoto(next);
      // A pause or manual edit can arrive during an unabortable commit. Keep
      // the committed cache current, then let the caller merge only untouched fields.
      if (adapter !== this.adapter || generation !== this.recognitionGeneration) return null;
      cache.set(source.id, { ...entry, photo: next });
      return { before, photo: next };
    });
    this.writeQueue = write.then(() => {}, () => {});
    return write;
  }

  public async saveFaceRecognition(photo: Photo, index: FaceRecognitionIndex | null): Promise<void> {
    const adapter = this.adapter;
    const generation = this.recognitionGeneration;
    // Snapshot caller-owned arrays before the queued write starts.
    const value = index === null ? null : structuredClone(index);
    const write = this.writeQueue.then(async () => {
      if (this.adapter !== adapter || generation !== this.recognitionGeneration) throw new Error('The archive changed while recognizing faces.');
      const cache = this.thumbnailCache(adapter);
      const entry = cache.get(photo.id);
      if (!entry) throw new Error('The photo is no longer in this archive.');
      if (entry.photo.originalUrl !== photo.originalUrl) throw new Error('The original photo changed while recognizing faces.');
      await adapter.saveFaceRecognition(photo.id, value);
      if (this.adapter !== adapter || generation !== this.recognitionGeneration) throw new Error('The archive changed while recognizing faces.');
      const updated = { ...entry.photo };
      if (value === null) delete updated.faceRecognition;
      else updated.faceRecognition = value;
      cache.set(photo.id, { ...entry, photo: updated });
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  public async savePhotoSimilarity(photo: Photo, index: PhotoSimilarityIndex | null): Promise<void> {
    const adapter = this.adapter;
    const generation = this.recognitionGeneration;
    const originalUrl = photo.originalUrl;
    const originalRevision = photo.originalRevision || 'legacy-v1';
    const value = index === null ? null : structuredClone(index);
    if (value !== null && value.originalRevision !== originalRevision) {
      throw new Error('The similarity index belongs to a different original photo.');
    }
    const write = this.writeQueue.then(async () => {
      if (this.adapter !== adapter || generation !== this.recognitionGeneration) throw new Error('The archive changed while indexing similarity.');
      const cache = this.thumbnailCache(adapter);
      const entry = cache.get(photo.id);
      if (!entry) throw new Error('The photo is no longer in this archive.');
      if (entry.photo.originalUrl !== originalUrl || (entry.photo.originalRevision || 'legacy-v1') !== originalRevision) {
        throw new Error('The original photo changed while indexing similarity.');
      }
      await adapter.savePhotoSimilarity(photo.id, value, originalRevision);
      if (this.adapter !== adapter || generation !== this.recognitionGeneration) throw new Error('The archive changed while indexing similarity.');
      const updated = { ...entry.photo };
      if (value === null) delete updated.similarityIndex;
      else updated.similarityIndex = value;
      cache.set(photo.id, { ...entry, photo: updated });
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  public async replaceOriginal(photo: Photo, originalUrl: string): Promise<Photo> {
    const adapter = this.adapter;
    const replacement = { ...photo, originalUrl, originalRevision: crypto.randomUUID(), isRestoring: false };
    delete replacement.restoredUrl;
    delete replacement.thumbnailUrl;
    delete replacement.thumbnailSource;
    delete replacement.faceRecognition;
    delete replacement.similarityIndex;
    delete replacement.autoSuggestions;
    const write = this.writeQueue.then(async () => {
      const prepared = await this.prepareThumbnail(replacement, adapter);
      await adapter.savePhoto(prepared, true);
      this.thumbnailCache(adapter).set(photo.id, { source: originalUrl, photo: prepared });
      return prepared;
    });
    this.writeQueue = write.then(() => {}, () => {});
    return write;
  }

  public async backfillThumbnails(photos: Photo[], onReady: (photo: Photo) => void, shouldStop: () => boolean): Promise<void> {
    const adapter = this.adapter;
    const cache = this.thumbnailCache(adapter);
    for (const photo of photos) {
      if (shouldStop() || adapter !== this.adapter) return;
      if (hasThumbnail(photo)) continue;
      // Yield between images and queue one job at a time so user edits can interleave.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const write = this.writeQueue.then(async () => {
        if (shouldStop() || adapter !== this.adapter) return;
        const latest = cache.get(photo.id);
        if (!latest || latest.source !== displaySource(photo) || hasThumbnail(latest.photo)) return;
        const prepared = await this.prepareThumbnail(latest.photo, adapter);
        if (!hasThumbnail(prepared) || shouldStop() || adapter !== this.adapter) return;
        await adapter.saveThumbnail(prepared);
        cache.set(photo.id, { source: displaySource(photo), photo: prepared });
        onReady(prepared);
      });
      this.writeQueue = write.catch(() => {});
      try { await write; }
      catch (error) { console.warn(`Could not store thumbnail for ${photo.id}`, error); }
    }
  }

  public async deletePhoto(id: string): Promise<void> {
    const adapter = this.adapter;
    const write = this.writeQueue.then(async () => {
      await adapter.deletePhoto(id);
      this.thumbnailCache(adapter).delete(id);
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }
}

export const storageService = new StorageService();

