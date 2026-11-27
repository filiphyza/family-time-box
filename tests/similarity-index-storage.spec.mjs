import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ancestry-lens-recognition-paused', 'true');
    localStorage.setItem('ancestry-lens-similarity-paused', 'true');
  });
});

const descriptor = {
  embedding: [1, ...Array(1023).fill(0)], gray: Array.from({ length: 256 }, (_, index) => index % 2 ? 1 : -1),
  mean: 128, deviation: 40, saturation: 0.2, aspect: 1.5,
};

for (const folder of [false, true]) {
  test(`similarity patches survive metadata edits and cleared data stays cleared (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async ({ folder, descriptor }) => {
      const { storageService } = await import('/services/storageService.ts');
      storageService.saveSettings({ language: 'en', storageType: folder ? 'filesystem' : 'local' });
      if (folder) {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('similarity-storage-patches', { create: true });
        window.showDirectoryPicker = async () => directory;
        if (!await storageService.connectFileSystem()) throw new Error('Could not connect test archive');
      }
      const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 32;
      const source = await storageService.savePhoto({ id: 'similarity-patch', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
        description: 'Original caption', people: ['Anna'], faceTags: [], tags: ['family'], dateOfPhoto: '', isRestoring: false });
      await storageService.saveFaceRecognition(source, { modelId: 'test-face-model', faces: [] });
      const index = { modelId: 'test-scene-model', preprocessingVersion: 1, originalRevision: source.originalRevision, descriptor };
      await Promise.all([
        storageService.savePhotoSimilarity(source, index),
        storageService.savePhoto({ ...source, description: 'Edited during indexing', dateOfPhoto: '1968-07', location: 'Garden' }),
      ]);
      const indexed = (await storageService.loadPhotos()).find(photo => photo.id === source.id);
      await Promise.all([
        storageService.savePhotoSimilarity(indexed, null),
        storageService.savePhoto({ ...indexed, description: 'Edited while clearing' }),
      ]);
      const cleared = (await storageService.loadPhotos()).find(photo => photo.id === source.id);
      return {
        revision: source.originalRevision, indexedRevision: indexed.originalRevision,
        indexed: indexed.similarityIndex, caption: indexed.description, date: indexed.dateOfPhoto, place: indexed.location,
        faceModel: indexed.faceRecognition?.modelId,
        cleared: !cleared.similarityIndex, finalCaption: cleared.description,
        people: cleared.people, tags: cleared.tags,
      };
    }, { folder, descriptor });
    expect(result.revision).toBeTruthy();
    expect(result.indexedRevision).toBe(result.revision);
    expect(result.indexed).toMatchObject({ modelId: 'test-scene-model', originalRevision: result.revision, descriptor });
    expect(result).toMatchObject({ caption: 'Edited during indexing', date: '1968-07', place: 'Garden', faceModel: 'test-face-model',
      cleared: true, finalCaption: 'Edited while clearing', people: ['Anna'], tags: ['family'] });
  });

  test(`original revisions persist and replacement rejects an old similarity result (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async ({ folder, descriptor }) => {
      const { storageService } = await import('/services/storageService.ts');
      storageService.saveSettings({ language: 'en', storageType: folder ? 'filesystem' : 'local' });
      if (folder) {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('similarity-storage-revision', { create: true });
        window.showDirectoryPicker = async () => directory;
        if (!await storageService.connectFileSystem()) throw new Error('Could not connect test archive');
      }
      const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 32;
      const source = await storageService.savePhoto({ id: 'similarity-revision', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
        description: 'Keep caption', people: ['Anna'], faceTags: [], tags: [], dateOfPhoto: '1968', isRestoring: false });
      const index = { modelId: 'test-scene-model', preprocessingVersion: 1, originalRevision: source.originalRevision, descriptor };
      await storageService.savePhotoSimilarity(source, index);
      const reopened = (await storageService.loadPhotos()).find(photo => photo.id === source.id);
      canvas.getContext('2d').fillRect(0, 0, 48, 32);
      const replaced = await storageService.replaceOriginal(reopened, canvas.toDataURL());
      const outcome = await storageService.savePhotoSimilarity(reopened, index).then(() => 'saved', () => 'rejected');
      const stored = (await storageService.loadPhotos()).find(photo => photo.id === source.id);
      return {
        initialRevision: source.originalRevision, reopenedRevision: reopened.originalRevision,
        reopenedIndexRevision: reopened.similarityIndex?.originalRevision, replacementRevision: replaced.originalRevision,
        indexed: Boolean(stored.similarityIndex), outcome, caption: stored.description, people: stored.people, date: stored.dateOfPhoto,
      };
    }, { folder, descriptor });
    expect(result.initialRevision).toBeTruthy();
    expect(result.reopenedRevision).toBe(result.initialRevision);
    expect(result.reopenedIndexRevision).toBe(result.initialRevision);
    expect(result.replacementRevision).not.toBe(result.initialRevision);
    expect(result).toMatchObject({ indexed: false, outcome: 'rejected', caption: 'Keep caption', people: ['Anna'], date: '1968' });
  });
}

test('queued similarity cannot write into another folder with the same photo ID', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async descriptor => {
    const { storageService } = await import('/services/storageService.ts');
    const root = await navigator.storage.getDirectory();
    const folders = await Promise.all(['similarity-archive-a', 'similarity-archive-b'].map(name => root.getDirectoryHandle(name, { create: true })));
    storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const photo = { id: 'same-similarity-id', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
      description: 'Shared ID', people: [], faceTags: [], tags: [], dateOfPhoto: '', isRestoring: false };
    const connect = async folder => {
      window.showDirectoryPicker = async () => folder;
      if (!await storageService.connectFileSystem()) throw new Error('Could not connect test archive');
    };
    for (const folder of folders) { await connect(folder); await storageService.savePhoto(photo); }
    await connect(folders[0]);
    const source = (await storageService.loadPhotos())[0];
    const index = { modelId: 'test-scene-model', preprocessingVersion: 1, originalRevision: source.originalRevision, descriptor };
    let release;
    storageService.writeQueue = new Promise(resolve => { release = resolve; });
    const pending = storageService.savePhotoSimilarity(source, index).then(() => 'saved', () => 'invalidated');
    await connect(folders[1]);
    release();
    const outcome = await pending;
    const records = await Promise.all(folders.map(async folder => JSON.parse(await (await (await folder.getFileHandle('ancestry_db.json')).getFile()).text())));
    return { outcome, indexed: records.map(photos => Boolean(photos[0].similarityIndex)) };
  }, descriptor);
  expect(result).toEqual({ outcome: 'invalidated', indexed: [false, false] });
});

test('a late similarity result cannot recreate a deleted photo', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async descriptor => {
    const { storageService } = await import('/services/storageService.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const source = await storageService.savePhoto({ id: 'similarity-deleted', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
      description: '', people: [], faceTags: [], tags: [], dateOfPhoto: '', isRestoring: false });
    const index = { modelId: 'test-scene-model', preprocessingVersion: 1, originalRevision: source.originalRevision, descriptor };
    await storageService.deletePhoto(source.id);
    const outcome = await storageService.savePhotoSimilarity(source, index).then(() => 'saved', () => 'rejected');
    return { outcome, present: (await storageService.loadPhotos()).some(photo => photo.id === source.id) };
  }, descriptor);
  expect(result).toEqual({ outcome: 'rejected', present: false });
});

test('legacy records keep a usable revision when their first similarity index is saved', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async descriptor => {
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    const { storageService } = await import('/services/storageService.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    await new BrowserPhotoStorage().savePhoto({ id: 'legacy-similarity', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
      description: '', people: [], faceTags: [], tags: [], dateOfPhoto: '', isRestoring: false });
    const source = (await storageService.loadPhotos()).find(photo => photo.id === 'legacy-similarity');
    await storageService.savePhotoSimilarity(source, { modelId: 'test-scene-model', preprocessingVersion: 1, originalRevision: 'legacy-v1', descriptor });
    await storageService.savePhoto({ ...source, description: 'Legacy caption edit' });
    const stored = (await storageService.loadPhotos()).find(photo => photo.id === source.id);
    return { revision: stored.originalRevision, indexRevision: stored.similarityIndex?.originalRevision, caption: stored.description };
  }, descriptor);
  expect(result).toEqual({ revision: 'legacy-v1', indexRevision: 'legacy-v1', caption: 'Legacy caption edit' });
});

test('persisted revision guards reject a similarity result after another storage instance replaces the photo', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async descriptor => {
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    const { storageService } = await import('/services/storageService.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const source = await storageService.savePhoto({ id: 'cross-instance-similarity', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
      description: '', people: [], faceTags: [], tags: [], dateOfPhoto: '', isRestoring: false });
    const other = new BrowserPhotoStorage();
    const replacementRevision = crypto.randomUUID();
    await other.savePhoto({ ...source, originalRevision: replacementRevision, description: 'Replacement from another instance' });
    const outcome = await storageService.savePhotoSimilarity(source, {
      modelId: 'test-scene-model', preprocessingVersion: 1, originalRevision: source.originalRevision, descriptor,
    }).then(() => 'saved', () => 'rejected');
    const stored = (await other.loadPhotos()).find(photo => photo.id === source.id);
    return { outcome, indexed: Boolean(stored.similarityIndex), revisionPreserved: stored.originalRevision === replacementRevision, caption: stored.description };
  }, descriptor);
  expect(result).toEqual({ outcome: 'rejected', indexed: false, revisionPreserved: true, caption: 'Replacement from another instance' });
});
