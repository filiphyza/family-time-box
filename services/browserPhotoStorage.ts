import type { Photo, FamilyTreeData, FaceRecognitionIndex, PhotoSimilarityIndex } from '../types';
import { BrowserFamilyTreeStorage } from './browserFamilyTreeStorage';

const LEGACY_KEY = 'ancestry-lens-photos';
const DB_NAME = 'ancestry-lens-archive';
const STORE_NAME = 'photos';

// Photo data belongs in IndexedDB; localStorage has a small per-origin string quota.
export class BrowserPhotoStorage {
  private familyTreeStorage = new BrowserFamilyTreeStorage();

  loadFamilyTree(): Promise<FamilyTreeData> { return this.familyTreeStorage.loadFamilyTree(); }
  saveFamilyTree(tree: FamilyTreeData): Promise<void> { return this.familyTreeStorage.saveFamilyTree(tree); }
  private database?: Promise<IDBDatabase>;
  private migration?: Promise<void>;

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.database = undefined; this.migration = undefined; };
          resolve(db);
        };
      }).catch(error => { this.database = undefined; throw error; });
    }
    return this.database;
  }

  private async migrateLegacyPhotos(): Promise<void> {
    if (!this.migration) {
      this.migration = this.migrate().catch(error => { this.migration = undefined; throw error; });
    }
    await this.migration;
  }

  private async migrate(): Promise<void> {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy === null) return;
    const photos: Photo[] = JSON.parse(legacy);
    if (!Array.isArray(photos) || photos.some(photo => !photo || typeof photo.id !== 'string')) {
      throw new Error('Could not migrate the existing browser archive. Your original browser data has been preserved.');
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const photo of photos) {
        const existing = store.get(photo.id);
        // Multiple tabs can migrate safely without overwriting newer saved edits.
        existing.onsuccess = () => { if (existing.result === undefined) store.put(photo); };
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser archive migration failed.'));
      transaction.onerror = () => {}; // The abort handler reports the transaction failure.
    });
    // Only free the legacy space after the entire migration commits successfully.
    if (localStorage.getItem(LEGACY_KEY) === legacy) localStorage.removeItem(LEGACY_KEY);
  }

  private async ready(): Promise<IDBDatabase> {
    await this.migrateLegacyPhotos();
    return this.open();
  }

  async loadPhotos(): Promise<Photo[]> {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      transaction.oncomplete = () => resolve((request.result as Photo[]).sort((a, b) => b.uploadDate - a.uploadDate));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not load browser photos.'));
      transaction.onerror = () => {};
    });
  }

  async savePhoto(photo: Photo): Promise<void> {
    const db = await this.ready();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(photo);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not save the photo.'));
      transaction.onerror = () => {};
    });
  }

  async savePhotoPeople(changes: Pick<Photo, 'id' | 'people' | 'faceTags'>[]): Promise<void> {
    if (!changes.length) return;
    const db = await this.ready();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      let failure: unknown;
      for (const change of changes) {
        const request = store.get(change.id);
        request.onsuccess = () => {
          try {
            if (!request.result) throw new Error('A photo is no longer in this archive.');
            store.put({ ...request.result, people: change.people, faceTags: change.faceTags });
          } catch (error) { failure = error; transaction.abort(); }
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Could not update photo names.'));
      transaction.onerror = () => {};
    });
  }

  async saveFaceRecognition(id: string, index: FaceRecognitionIndex | null): Promise<void> {
    const db = await this.ready();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);
      let failure: unknown;
      request.onsuccess = () => {
        try {
          if (!request.result) throw new Error('The photo is no longer in this archive.');
          const photo: Photo = { ...request.result };
          if (index === null) delete photo.faceRecognition;
          else photo.faceRecognition = index;
          store.put(photo);
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Could not save face recognition data.'));
      transaction.onerror = () => {};
    });
  }

  async savePhotoSimilarity(id: string, index: PhotoSimilarityIndex | null, originalRevision?: string): Promise<void> {
    const db = await this.ready();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);
      let failure: unknown;
      request.onsuccess = () => {
        try {
          if (!request.result) throw new Error('The photo is no longer in this archive.');
          const photo: Photo = { ...request.result };
          if (originalRevision !== undefined && (photo.originalRevision || 'legacy-v1') !== originalRevision) {
            throw new Error('The original photo changed while indexing similarity.');
          }
          if (index === null) delete photo.similarityIndex;
          else photo.similarityIndex = index;
          store.put(photo);
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Could not save photo similarity data.'));
      transaction.onerror = () => {};
    });
  }

  async saveThumbnail(photo: Photo): Promise<void> {
    const db = await this.ready();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(photo.id);
      request.onsuccess = () => {
        // A background preview must not recreate a deleted photo or overwrite newer metadata.
        if (request.result) store.put({ ...request.result, thumbnailUrl: photo.thumbnailUrl, thumbnailSource: photo.thumbnailSource });
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not save thumbnail.'));
      transaction.onerror = () => {};
    });
  }

  async deletePhoto(id: string): Promise<void> {
    const db = await this.ready();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not delete the photo.'));
      transaction.onerror = () => {};
    });
  }
}

