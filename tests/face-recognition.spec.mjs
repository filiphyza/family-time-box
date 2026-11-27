import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

const vector = index => Array.from({ length: 128 }, (_, position) => Number(position === index));
const targetFaces = [
  { id: 'recognition-1', x: 10, y: 20, width: 20, height: 30, confidence: 0.98, embedding: vector(0) },
  { id: 'recognition-2', x: 60, y: 20, width: 20, height: 30, confidence: 0.95, embedding: vector(1) },
];
const sourceFaces = [{ ...targetFaces[0], id: 'reference-1' }];

async function fakeRecognition(page, mode = 'result') {
  await page.addInitScript(({ targetFaces, sourceFaces, mode }) => {
    const NativeWorker = window.Worker;
    window.recognitionStarts = 0;
    window.recognitionStops = 0;
    window.recognitionReleases = [];
    window.Worker = class {
      constructor(url, options) {
        this.recognition = String(url).includes('faceRecognition.worker');
        if (!this.recognition && !String(url).includes('faceDetection.worker')) return new NativeWorker(url, options);
      }
      postMessage(message) {
        const target = message.image.width === 600;
        message.image.close();
        if (this.recognition) window.recognitionStarts++;
        const complete = () => {
          if (!this.stopped) this.onmessage?.({ data: this.recognition && mode === 'error' ? { type: 'error', message: 'Test inference failure' } : {
            type: 'result', faces: this.recognition ? (target ? targetFaces : sourceFaces) : targetFaces,
          } });
        };
        if (this.recognition && mode === 'held') window.recognitionReleases.push(complete);
        else setTimeout(complete, 20);
      }
      terminate() { if (!this.stopped && this.recognition) window.recognitionStops++; this.stopped = true; }
    };
  }, { targetFaces, sourceFaces, mode });
}

async function seed(page, folder = false) {
  await page.goto('/');
  const replacement = await page.evaluate(async ({ folder, targetFaces, sourceFaces }) => {
    const { storageService } = await import('/services/storageService.ts');
    const { SFACE_MODEL_ID } = await import('/services/faceRecognition.ts');
    localStorage.setItem('ancestry-lens-recognition-paused', 'true');
    if (folder) {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('face-recognition-test', { create: true });
      window.showDirectoryPicker = async () => archive;
      storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
      if (!await storageService.connectFileSystem()) throw new Error('Could not connect test archive');
    }
    const image = (width, color) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 400;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, width, 400);
      return canvas.toDataURL();
    };
    for (const target of [false, true]) await storageService.savePhoto({
      id: target ? 'recognition-target' : 'recognition-source',
      fileName: target ? 'target.png' : 'source.png', uploadDate: target ? 2 : 1,
      description: target ? 'Recognition target' : 'Recognition reference',
      originalUrl: image(target ? 600 : 601, target ? '#304090' : '#408030'),
      people: target ? [] : ['Anna'], faceTags: target ? [] : [{ id: 'human-source', name: 'Anna', x: 20, y: 35 }],
      tags: [], dateOfPhoto: '', isRestoring: false,
      faceRecognition: { modelId: SFACE_MODEL_ID, faces: target ? targetFaces : sourceFaces },
    });
    await storageService.saveFamilyTree({ rootId: 'anna-id', people: [{ id: 'anna-id', name: 'Anna' }], families: [] });
    return image(602, '#901010');
  }, { folder, targetFaces, sourceFaces });
  await page.reload();
  await page.getByRole('img', { name: 'Recognition target', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  return { editor: page.getByRole('dialog', { name: 'Photo Details', exact: true }), replacement };
}

// Read raw records rather than hydrate filesystem images and replace the service's
// source cache while an editor/scan still holds its original session URLs.
async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    await storageService.writeQueue;
    if (JSON.parse(localStorage.getItem('ancestry-lens-settings') || '{}').storageType === 'filesystem') {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('face-recognition-test');
      return JSON.parse(await (await (await archive.getFileHandle('ancestry_db.json')).getFile()).text());
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ancestry-lens-archive', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('photos', 'readonly');
        const records = transaction.objectStore('photos').getAll();
        transaction.oncomplete = () => { db.close(); resolve(records.result); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  });
}
const targetRecord = async page => (await stored(page)).find(photo => photo.id === 'recognition-target');
const region = editor => editor.getByRole('region', { name: 'Face recognition', exact: true });
async function scan(editor) {
  const panel = region(editor);
  await expect(panel.getByRole('button', { name: 'Confirm name: Anna', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Suggest names', exact: true })).toHaveCount(0);
  return panel;
}

for (const folder of [false, true]) {
  test(`suggestions require confirmation and persist identity (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
    await fakeRecognition(page);
    const { editor } = await seed(page, folder);
    const panel = await scan(editor);
    const before = await targetRecord(page);
    expect(before.faceTags).toEqual([]);
    expect(before.people).toEqual([]);
    expect(before.faceRecognition.faces).toHaveLength(2);
    await panel.getByRole('button', { name: 'Confirm name: Anna', exact: true }).click();
    await expect.poll(async () => (await targetRecord(page)).faceTags.length).toBe(1);
    expect((await targetRecord(page)).faceTags[0]).toMatchObject({ name: 'Anna', personId: 'anna-id', x: 20, y: 35 });
    expect((await targetRecord(page)).people).toEqual(['Anna']);
    await page.reload();
    expect((await targetRecord(page)).faceTags[0]).toMatchObject({ name: 'Anna', personId: 'anna-id' });
  });

  test(`clearing signatures keeps confirmed tags (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
    await fakeRecognition(page);
    const { editor } = await seed(page, folder);
    const panel = await scan(editor);
    await panel.getByRole('button', { name: 'Confirm name: Anna', exact: true }).click();
    await expect.poll(async () => (await targetRecord(page)).faceTags.length).toBe(1);
    const tags = (await stored(page)).map(photo => ({ id: photo.id, faceTags: photo.faceTags, people: photo.people }));
    await panel.getByRole('button', { name: 'Clear saved face signatures from this archive', exact: true }).click();
    // The folder writes one record at a time. Wait for the UI's completed state
    // before reading a raw File snapshot that another commit could invalidate.
    await expect(panel.getByRole('button', { name: 'Clear saved face signatures from this archive', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await stored(page)).every(photo => !photo.faceRecognition)).toBe(true);
    expect((await stored(page)).map(photo => ({ id: photo.id, faceTags: photo.faceTags, people: photo.people }))).toEqual(tags);
    await page.reload();
    expect((await stored(page)).every(photo => !photo.faceRecognition)).toBe(true);
    expect((await targetRecord(page)).faceTags[0].name).toBe('Anna');
  });

  test(`replacing original invalidates saved signatures (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
    await fakeRecognition(page);
    const { editor, replacement } = await seed(page, folder);
    await scan(editor);
    page.once('dialog', dialog => dialog.accept());
    await editor.locator('input[type=file]').setInputFiles({ name: 'new-scan.png', mimeType: 'image/png', buffer: Buffer.from(replacement.split(',')[1], 'base64') });
    await expect(editor.getByRole('status').filter({ hasText: 'Original replaced' })).toBeVisible();
    expect((await targetRecord(page)).faceRecognition).toBeUndefined();
    expect((await stored(page)).find(photo => photo.id === 'recognition-source').faceRecognition).toBeTruthy();
  });
}

test('a suggested name can be corrected and unknown faces can be named manually', async ({ page }) => {
  await fakeRecognition(page);
  const { editor } = await seed(page);
  const panel = await scan(editor);
  await panel.getByRole('button', { name: 'Detected face 1 · Anna', exact: true }).click();
  const picker = editor.getByRole('combobox', { name: 'Who is this?', exact: true });
  await picker.fill('Peter');
  await editor.getByRole('button', { name: 'Tag person', exact: true }).click();
  await expect.poll(async () => (await targetRecord(page)).faceTags.length).toBe(1);
  expect((await targetRecord(page)).faceTags[0]).toMatchObject({ name: 'Peter' });
  expect((await targetRecord(page)).faceTags[0].personId).toBeUndefined();
  await expect(panel.getByRole('button', { name: 'Confirm name: Anna', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Detected face 1 · Unknown', exact: true }).click();
  await picker.fill('Mária');
  await editor.getByRole('button', { name: 'Tag person', exact: true }).click();
  await expect.poll(async () => (await targetRecord(page)).people).toEqual(['Peter', 'Mária']);
});







test('queued metadata edits neither remove a new index nor restore a cleared one', async ({ page }) => {
  await fakeRecognition(page);
  await seed(page);
  const records = await page.evaluate(async faces => {
    const { storageService } = await import('/services/storageService.ts');
    const { SFACE_MODEL_ID } = await import('/services/faceRecognition.ts');
    let photo = (await storageService.loadPhotos()).find(item => item.id === 'recognition-target');
    await storageService.saveFaceRecognition(photo, null);
    photo = (await storageService.loadPhotos()).find(item => item.id === 'recognition-target');
    await Promise.all([
      storageService.saveFaceRecognition(photo, { modelId: SFACE_MODEL_ID, faces }),
      storageService.savePhoto({ ...photo, description: 'Metadata queued after indexing' }),
    ]);
    const afterIndex = (await storageService.loadPhotos()).find(item => item.id === photo.id);
    await Promise.all([
      storageService.saveFaceRecognition(afterIndex, null),
      storageService.savePhoto({ ...afterIndex, description: 'Metadata queued after clearing' }),
    ]);
    const afterClear = (await storageService.loadPhotos()).find(item => item.id === photo.id);
    return { afterIndex, afterClear };
  }, targetFaces);
  expect(records.afterIndex.faceRecognition.faces).toEqual(targetFaces);
  expect(records.afterIndex.description).toBe('Metadata queued after indexing');
  expect(records.afterClear.faceRecognition).toBeUndefined();
  expect(records.afterClear.description).toBe('Metadata queued after clearing');
});

test('a dismissed recognition box stays dismissed without changing human labels', async ({ page }) => {
  await fakeRecognition(page);
  const { editor } = await seed(page);
  const panel = await scan(editor);
  await panel.getByRole('button', { name: 'Detected face 1 · Anna', exact: true }).click();
  await editor.getByRole('button', { name: 'Dismiss this box', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Confirm name: Anna', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Detected face 1 · Unknown', exact: true })).toBeVisible();
  expect((await targetRecord(page)).faceTags).toEqual([]);
  expect((await targetRecord(page)).people).toEqual([]);
});

test('real local SFace worker recognizes a public test portrait without external inference', async ({ page }) => {
  test.setTimeout(120000);
  // Official White House portrait by Pete Souza, public domain. Retrieved only by
  // the test runner; no archive photo or browser inference is sent externally.
  const fixture = await fetch('https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama.jpg');
  expect(fixture.ok).toBe(true);
  const bytes = Buffer.from(await fixture.arrayBuffer());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('0930e3aa8cae5920329c0c8cbc6a2ab70f47b0e67b432875beaa95cbf7e741f6');
  const source = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  await page.goto('/');
  const external = [];
  page.on('request', request => {
    if (request.url().startsWith('http') && !['localhost', '127.0.0.1'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  const results = await page.evaluate(async source => {
    const { createFaceRecognizer } = await import('/services/faceRecognition.ts');
    const { suggestFace } = await import('/utils/faceMatching.ts');
    const recognizer = createFaceRecognizer();
    try {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * 0.65); canvas.height = Math.round(image.height * 0.65);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const first = await recognizer.recognize(source, { signal: new AbortController().signal });
      const resized = await recognizer.recognize(canvas.toDataURL(), { signal: new AbortController().signal });
      const match = first[0] && resized[0] ? suggestFace(resized[0], [{ name: 'Test portrait', embedding: first[0].embedding, photoId: 'public-test', faceId: first[0].id }]) : null;
      canvas.width = canvas.height = 256;
      const blank = await recognizer.recognize(canvas.toDataURL(), { signal: new AbortController().signal });
      return { first, resized, match, blank };
    } finally { recognizer.dispose(); }
  }, source);
  expect(results.first).toHaveLength(1);
  expect(results.resized).toHaveLength(1);
  expect(results.first[0].embedding).toHaveLength(128);
  expect(Math.hypot(...results.first[0].embedding)).toBeCloseTo(1, 4);
  expect(results.match).toMatchObject({ name: 'Test portrait' });
  expect(results.match.similarity).toBeGreaterThan(0.8);
  expect(results.blank).toEqual([]);
  expect(external).toEqual([]);
});


test('recognition suggestions remain usable on desktop and mobile', async ({ page }, testInfo) => {
  await fakeRecognition(page);
  const { editor } = await seed(page);
  const panel = await scan(editor);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('recognition-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByRole('button', { name: 'Confirm name: Anna', exact: true })).toBeVisible();
  const width = await editor.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  await page.screenshot({ path: testInfo.outputPath('recognition-mobile.png') });
});
