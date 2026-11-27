import { test, expect } from '@playwright/test';

const index = { modelId: 'storage-race-model', faces: [{
  id: 'face-1', x: 10, y: 10, width: 20, height: 30, confidence: 0.99,
  embedding: [1, ...Array(127).fill(0)],
}] };

test('queued recognition cannot write into another folder with the same photo ID', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async index => {
    const { storageService } = await import('/services/storageService.ts');
    const root = await navigator.storage.getDirectory();
    const folders = await Promise.all(['recognition-archive-a', 'recognition-archive-b'].map(name => root.getDirectoryHandle(name, { create: true })));
    storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const photo = { id: 'same-photo-id', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
      description: 'Shared ID fixture', people: [], faceTags: [], tags: [], dateOfPhoto: '', isRestoring: false };
    const connect = async folder => {
      window.showDirectoryPicker = async () => folder;
      if (!await storageService.connectFileSystem()) throw new Error('Test archive could not connect');
    };
    for (const folder of folders) { await connect(folder); await storageService.savePhoto(photo); }
    await connect(folders[0]);
    const source = (await storageService.loadPhotos())[0];
    let release;
    storageService.writeQueue = new Promise(resolve => { release = resolve; });
    const outcome = storageService.saveFaceRecognition(source, index).then(() => 'saved', () => 'invalidated');
    await connect(folders[1]);
    release();
    const state = await outcome;
    const records = await Promise.all(folders.map(async folder => JSON.parse(await (await (await folder.getFileHandle('ancestry_db.json')).getFile()).text())));
    return { state, indexed: records.map(photos => Boolean(photos[0].faceRecognition)) };
  }, index);
  expect(result).toEqual({ state: 'invalidated', indexed: [false, false] });
});

test('language-only settings preserve the active recognition generation and source cache', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async index => {
    const { storageService } = await import('/services/storageService.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const photo = { id: 'language-photo', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
      description: '', people: [], faceTags: [], tags: [], dateOfPhoto: '', isRestoring: false };
    await storageService.savePhoto(photo);
    let release;
    storageService.writeQueue = new Promise(resolve => { release = resolve; });
    const outcome = storageService.saveFaceRecognition(photo, index).then(() => 'saved', () => 'invalidated');
    storageService.saveSettings({ ...storageService.getSettings(), language: 'sk' });
    release();
    const state = await outcome;
    const stored = (await storageService.loadPhotos()).find(item => item.id === photo.id);
    return { state, modelId: stored.faceRecognition?.modelId };
  }, index);
  expect(result).toEqual({ state: 'saved', modelId: index.modelId });
});

test('changing storage settings invalidates queued recognition before persistence', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async index => {
    const { storageService } = await import('/services/storageService.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const photo = { id: 'switch-photo', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
      description: '', people: [], faceTags: [], tags: [], dateOfPhoto: '', isRestoring: false };
    await storageService.savePhoto(photo);
    let release;
    storageService.writeQueue = new Promise(resolve => { release = resolve; });
    const outcome = storageService.saveFaceRecognition(photo, index).then(() => 'saved', () => 'invalidated');
    storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
    release();
    const state = await outcome;
    storageService.saveSettings({ language: 'en', storageType: 'local' });
    const stored = (await storageService.loadPhotos()).find(item => item.id === photo.id);
    return { state, indexed: Boolean(stored.faceRecognition) };
  }, index);
  expect(result).toEqual({ state: 'invalidated', indexed: false });
});

test('photo loading and cache refresh finish before a background signature write begins', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async index => {
    const { storageService } = await import('/services/storageService.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const photo = { id: 'loading-photo', fileName: 'test.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
      description: '', people: [], faceTags: [], tags: [], dateOfPhoto: '', isRestoring: false };
    await storageService.savePhoto(photo);
    const adapter = storageService.adapter;
    const nativeLoad = adapter.loadPhotos.bind(adapter);
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    adapter.loadPhotos = async () => {
      const snapshot = await nativeLoad();
      started();
      await new Promise(resolve => { release = resolve; });
      return snapshot;
    };
    const load = storageService.loadPhotos();
    await ready;
    const patch = storageService.saveFaceRecognition(photo, index);
    const order = await Promise.race([patch.then(() => 'patch-first'), new Promise(resolve => setTimeout(() => resolve('read-first'), 40))]);
    release();
    await Promise.all([load, patch]);
    adapter.loadPhotos = nativeLoad;
    // A later ordinary metadata save must retain the index in the source cache.
    await storageService.savePhoto({ ...photo, description: 'Edited after loading' });
    const stored = (await storageService.loadPhotos()).find(item => item.id === photo.id);
    return { order, modelId: stored.faceRecognition?.modelId, description: stored.description };
  }, index);
  expect(result).toEqual({ order: 'read-first', modelId: index.modelId, description: 'Edited after loading' });
});
