import { test, expect } from '@playwright/test';

const jobs = page => page.getByRole('dialog', { name: 'Jobs', exact: true });
const similarity = page => jobs(page).getByRole('region', { name: 'Photo similarity', exact: true });
const indexed = records => records.filter(photo => photo.similarityIndex);

async function fakeWorkers(page, { held = false, failures = [] } = {}) {
  await page.addInitScript(({ held, failures }) => {
    const NativeWorker = window.Worker;
    window.similarityStarts = [];
    window.faceStarts = [];
    window.similarityPending = [];
    window.similarityFailures = failures;
    window.similarityHeld = held;
    window.heavyActive = 0;
    window.heavyMaxActive = 0;
    window.Worker = class {
      constructor(url, options) {
        this.scene = String(url).includes('sceneEmbedding.worker');
        this.face = String(url).includes('faceRecognition.worker');
        if (!this.scene && !this.face) return new NativeWorker(url, options);
      }
      postMessage({ image }) {
        const width = image.width;
        image.close();
        (this.scene ? window.similarityStarts : window.faceStarts).push(width);
        this.pending = true;
        window.heavyActive++;
        window.heavyMaxActive = Math.max(window.heavyMaxActive, window.heavyActive);
        const complete = () => {
          if (!this.pending) return;
          this.pending = false;
          window.heavyActive--;
          if (this.stopped) return;
          const descriptor = {
            embedding: Array.from({ length: 1024 }, (_, index) => Number(index === (width === 602 ? 1 : 0))),
            gray: Array.from({ length: 256 }, (_, index) => index % 2 ? 1 : -1),
            mean: 128, deviation: 50, saturation: 0.1, aspect: 1.5,
          };
          this.onmessage?.({ data: this.scene && window.similarityFailures.includes(width)
            ? { type: 'error', message: 'Test scene inference failure' }
            : this.scene ? { type: 'result', descriptor } : { type: 'result', faces: [] } });
        };
        if (this.scene && window.similarityHeld) window.similarityPending.push(complete);
        else setTimeout(complete, 25);
      }
      terminate() {
        if (this.stopped) return;
        if (this.pending) { this.pending = false; window.heavyActive--; }
        this.stopped = true;
      }
    };
  }, { held, failures });
}

async function seed(page, { folder = false, paused = false, faceEnabled = false, references = false } = {}) {
  await page.goto('/');
  await page.evaluate(async ({ folder, paused, faceEnabled, references }) => {
    const { storageService } = await import('/services/storageService.ts');
    localStorage.setItem('ancestry-lens-similarity-paused', String(paused));
    localStorage.setItem('ancestry-lens-recognition-paused', String(!faceEnabled));
    storageService.saveSettings({ language: 'en', storageType: folder ? 'filesystem' : 'local' });
    if (folder) {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('similarity-background-test', { create: true });
      window.showDirectoryPicker = async () => archive;
      if (!await storageService.connectFileSystem()) throw new Error('Test archive unavailable');
    }
    for (let index = 0; index < 3; index++) {
      const canvas = document.createElement('canvas'); canvas.width = 600 + index; canvas.height = 400;
      const context = canvas.getContext('2d');
      context.fillStyle = ['#243950', '#30472a', '#50293c'][index]; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#cfb678'; context.fillRect(40, 40, 120, 180);
      const reference = references && (index === 0 || references === 2 && index === 2);
      await storageService.savePhoto({
        id: `similarity-${index}`, originalUrl: canvas.toDataURL(), fileName: `similarity-${index}.png`,
        uploadDate: 3 - index, description: `Similarity photo ${index + 1}`,
        dateOfPhoto: reference ? index === 0 ? '1970-06' : '1990-08' : '',
        location: reference ? index === 0 ? 'Family garden' : 'Other setting' : '',
        people: index === 0 ? ['Anna'] : [], tags: ['family'],
        faceTags: index === 0 ? [{ id: 'anna', name: 'Anna', x: 20, y: 30 }] : [], isRestoring: false,
      });
    }
  }, { folder, paused, faceEnabled, references });
  await page.reload();
  await expect(page.getByRole('img', { name: 'Similarity photo 1', exact: true })).toBeVisible();
}

async function stored(page, folderName = 'similarity-background-test') {
  return page.evaluate(async folderName => {
    const { storageService } = await import('/services/storageService.ts');
    // Serialize raw snapshots with archive writes without rehydrating Blob URLs.
    const read = storageService.writeQueue.then(async () => {
      if (storageService.getSettings().storageType === 'filesystem') {
        const root = await navigator.storage.getDirectory();
        const archive = await root.getDirectoryHandle(folderName);
        return JSON.parse(await (await (await archive.getFileHandle('ancestry_db.json')).getFile()).text());
      }
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('ancestry-lens-archive', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('photos', 'readonly');
          const photos = transaction.objectStore('photos').getAll();
          transaction.oncomplete = () => { db.close(); resolve(photos.result); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      });
    });
    storageService.writeQueue = read.then(() => {}, () => {});
    return read;
  }, folderName);
}

async function openJobs(page) {
  if (!await jobs(page).isVisible()) {
    const editor = page.getByRole('dialog', { name: 'Photo Details', exact: true });
    const trigger = await editor.isVisible() ? editor : page.locator('header');
    await trigger.getByRole('button', { name: 'Jobs', exact: true }).click();
  }
  return similarity(page);
}

async function openEditor(page, index = 1) {
  if (await jobs(page).isVisible()) await jobs(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('img', { name: `Similarity photo ${index}`, exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  return page.getByRole('dialog', { name: 'Photo Details', exact: true });
}

async function finishAll(page) {
  await page.evaluate(() => {
    window.similarityHeld = false;
    window.similarityPending.splice(0).forEach(complete => complete());
  });
}

for (const folder of [false, true]) {
  test(`automatically persists every similarity fingerprint and reuses it after reload (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
    await fakeWorkers(page);
    await seed(page, { folder });
    await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
    expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602]);
    expect(await page.evaluate(() => window.heavyMaxActive)).toBe(1);
    const records = await stored(page);
    expect(records.every(photo => photo.dateOfPhoto === '')).toBe(true);
    for (const photo of records) {
      expect(photo.similarityIndex).toMatchObject({ preprocessingVersion: 1, originalRevision: photo.originalRevision || 'legacy-v1' });
      expect(photo.similarityIndex.descriptor.embedding).toHaveLength(1024);
    }
    await expect(await openJobs(page)).toContainText(/3\s*\/\s*3/);
    await page.reload();
    await expect(await openJobs(page)).toContainText(/3\s*\/\s*3/);
    expect(await page.evaluate(() => window.similarityStarts)).toEqual([]);
  });
}

test('prioritizes the opened photo after current work and continues after closing the editor', async ({ page }) => {
  await fakeWorkers(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600]);
  const editor = await openEditor(page, 3);
  await page.evaluate(() => window.similarityPending.shift()?.());
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600, 602]);
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate(() => window.heavyActive)).toBe(1);
  await finishAll(page);
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 602, 601]);
});

test('pause stops unfinished inference and resumes only missing fingerprints after reload', async ({ page }) => {
  await fakeWorkers(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600]);
  await page.evaluate(() => window.similarityPending.shift()?.());
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600, 601]);
  const panel = await openJobs(page);
  await panel.getByRole('button', { name: 'Pause similarity scan', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Resume similarity scan', exact: true })).toBeVisible();
  await finishAll(page);
  expect(indexed(await stored(page))).toHaveLength(1);
  await page.reload();
  await expect((await openJobs(page)).getByRole('button', { name: 'Resume similarity scan', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([]);
  await similarity(page).getByRole('button', { name: 'Resume similarity scan', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([601]);
  await finishAll(page);
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([601, 602]);
});

test('a failed photo does not block the queue and can be retried in Jobs', async ({ page }) => {
  await fakeWorkers(page, { failures: [601] });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602]);
  const panel = await openJobs(page);
  await expect(panel.getByRole('button', { name: 'Retry failed photos', exact: true })).toBeVisible();
  expect(indexed(await stored(page))).toHaveLength(2);
  await page.evaluate(() => { window.similarityFailures = []; });
  await panel.getByRole('button', { name: 'Retry failed photos', exact: true }).click();
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602, 601]);
});

test('a metadata edit during inference survives and does not restart image analysis', async ({ page }) => {
  await fakeWorkers(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600]);
  const editor = await openEditor(page);
  await editor.locator('textarea').fill('Updated while similarity indexing is active');
  await finishAll(page);
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  const record = (await stored(page)).find(photo => photo.id === 'similarity-0');
  expect(record).toMatchObject({ description: 'Updated while similarity indexing is active', people: ['Anna'], tags: ['family'], dateOfPhoto: '' });
  expect(record.faceTags).toEqual([{ id: 'anna', name: 'Anna', x: 20, y: 30 }]);
  await editor.locator('textarea').fill('Another metadata edit after indexing');
  await expect.poll(async () => (await stored(page)).find(photo => photo.id === 'similarity-0').description).toBe('Another metadata edit after indexing');
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602]);
});

test('an imported photo alone joins the catalogue', async ({ page }) => {
  await fakeWorkers(page);
  await seed(page);
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 604; canvas.height = 400;
    canvas.getContext('2d').fillRect(0, 0, 604, 400);
    return canvas.toDataURL();
  });
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'new-similarity.png', mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') });
  await expect.poll(async () => indexed(await stored(page)).length).toBe(4);
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602, 604]);
});

test('replacing an active original rejects the late result and indexes its new revision', async ({ page }) => {
  await fakeWorkers(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600]);
  const before = (await stored(page)).find(photo => photo.id === 'similarity-0');
  const editor = await openEditor(page);
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 603; canvas.height = 400;
    canvas.getContext('2d').fillRect(0, 0, 603, 400);
    return canvas.toDataURL();
  });
  page.once('dialog', dialog => dialog.accept());
  await editor.locator('input[type=file]').setInputFiles({ name: 'new-original.png', mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') });
  await expect(editor.getByRole('status').filter({ hasText: 'Original replaced' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600, 603]);
  await page.evaluate(() => window.similarityPending.shift()?.());
  expect((await stored(page)).find(photo => photo.id === 'similarity-0').similarityIndex).toBeUndefined();
  await finishAll(page);
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  const after = (await stored(page)).find(photo => photo.id === 'similarity-0');
  expect(after.originalRevision).not.toBe(before.originalRevision);
  expect(after.similarityIndex.originalRevision).toBe(after.originalRevision);
  expect(after.description).toBe(before.description);
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 603, 601, 602]);
});

test('deleting an active photo cannot restore its fingerprint or photo record', async ({ page }) => {
  await fakeWorkers(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600]);
  const editor = await openEditor(page);
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600, 601]);
  await finishAll(page);
  await expect.poll(async () => indexed(await stored(page)).length).toBe(2);
  expect((await stored(page)).some(photo => photo.id === 'similarity-0')).toBe(false);
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602]);
});

test('face and similarity background inference share one heavy worker slot', async ({ page }) => {
  await fakeWorkers(page);
  await seed(page, { faceEnabled: true });
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  expect(await page.evaluate(() => window.similarityStarts)).toHaveLength(3);
  expect(await page.evaluate(() => window.faceStarts)).toHaveLength(3);
  expect(await page.evaluate(() => window.heavyMaxActive)).toBe(1);
});

test('saved scene fingerprints supply suggestions after reload without another inference', async ({ page }, testInfo) => {
  await fakeWorkers(page);
  await seed(page, { references: true });
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  await page.reload();
  const editor = await openEditor(page, 2);
  const suggestions = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(suggestions.getByRole('button', { name: 'Compare scenes and objects', exact: true })).toBeEnabled();
  await suggestions.getByRole('button', { name: 'Compare scenes and objects', exact: true }).click();
  await expect(suggestions.getByRole('button', { name: 'Use date: June 1970', exact: true })).toBeVisible();
  expect((await stored(page)).find(photo => photo.id === 'similarity-1').dateOfPhoto).toBe('');
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([]);
  await suggestions.getByRole('button', { name: 'Use date: June 1970', exact: true }).click();
  await expect.poll(async () => (await stored(page)).find(photo => photo.id === 'similarity-1').dateOfPhoto).toBe('1970-06');
  await openJobs(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await jobs(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('similarity-catalogue-mobile.png') });
});

test('a fingerprint from an older model alone is rebuilt', async ({ page }) => {
  await fakeWorkers(page);
  await seed(page);
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  await page.evaluate(async () => {
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    const storage = new BrowserPhotoStorage();
    const photo = (await storage.loadPhotos()).find(photo => photo.id === 'similarity-1');
    photo.similarityIndex.modelId = 'old-scene-model';
    await storage.savePhoto(photo);
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([601]);
  await expect.poll(async () => (await stored(page)).find(photo => photo.id === 'similarity-1').similarityIndex.modelId).not.toBe('old-scene-model');
});

test('switching archives rejects a held result when photo IDs are reused', async ({ page }) => {
  await fakeWorkers(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600]);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const archive = await root.getDirectoryHandle('similarity-switched-test', { create: true });
    await archive.getDirectoryHandle('images', { create: true });
    const canvas = document.createElement('canvas'); canvas.width = 605; canvas.height = 400;
    canvas.getContext('2d').fillRect(0, 0, 605, 400);
    const writer = await (await archive.getFileHandle('ancestry_db.json', { create: true })).createWritable();
    await writer.write(JSON.stringify([{ id: 'similarity-0', originalUrl: canvas.toDataURL(), fileName: 'other-original.png',
      uploadDate: 1, description: 'Other archive photo', people: [], tags: [], faceTags: [], dateOfPhoto: '', isRestoring: false }]));
    await writer.close();
    window.showDirectoryPicker = async () => archive;
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Data Storage', exact: true }).click();
  await page.getByText('Local Native', { exact: true }).click();
  await page.getByRole('button', { name: 'Select Archive Folder', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Other archive photo', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600, 605]);
  await page.evaluate(() => window.similarityPending.shift()?.());
  expect((await stored(page, 'similarity-switched-test'))[0].similarityIndex).toBeUndefined();
  await finishAll(page);
  await expect.poll(async () => indexed(await stored(page, 'similarity-switched-test')).length).toBe(1);
  const originalArchive = await page.evaluate(async () => {
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    return new BrowserPhotoStorage().loadPhotos();
  });
  expect(originalArchive.every(photo => !photo.similarityIndex)).toBe(true);
  expect(await page.evaluate(() => window.heavyMaxActive)).toBe(1);
});

test('similarity starts automatically when no pause preference exists', async ({ page }) => {
  await fakeWorkers(page);
  await seed(page, { paused: true });
  await page.evaluate(() => localStorage.removeItem('ancestry-lens-similarity-paused'));
  await page.reload();
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602]);
  await expect((await openJobs(page)).getByRole('button', { name: 'Pause similarity scan', exact: true })).toBeVisible();
});

test('a legacy photo edited during indexing keeps its fingerprint without rescanning', async ({ page }) => {
  await fakeWorkers(page, { held: true });
  await seed(page, { paused: true });
  await page.evaluate(async () => {
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    const storage = new BrowserPhotoStorage();
    const photo = (await storage.loadPhotos()).find(photo => photo.id === 'similarity-0');
    delete photo.originalRevision;
    await storage.savePhoto(photo);
  });
  await page.reload();
  await (await openJobs(page)).getByRole('button', { name: 'Resume similarity scan', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600]);
  const editor = await openEditor(page);
  await editor.locator('textarea').fill('Legacy description edited during indexing');
  await expect.poll(async () => (await stored(page)).find(photo => photo.id === 'similarity-0').originalRevision).toBe('legacy-v1');
  await finishAll(page);
  await expect.poll(async () => indexed(await stored(page)).length).toBe(3);
  const photo = (await stored(page)).find(photo => photo.id === 'similarity-0');
  expect(photo).toMatchObject({ description: 'Legacy description edited during indexing', originalRevision: 'legacy-v1',
    similarityIndex: { originalRevision: 'legacy-v1' } });
  expect(await page.evaluate(async () => {
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    const { validSimilarityIndex } = await import('/services/sceneEmbedding.ts');
    return (await new BrowserPhotoStorage().loadPhotos()).every(validSimilarityIndex);
  })).toBe(true);
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602]);
  await expect((await openJobs(page)).getByRole('button', { name: 'Retry failed photos', exact: true })).toHaveCount(0);
});

test('manual scene comparison survives background fingerprint updates and keeps complete results', async ({ page }) => {
  await fakeWorkers(page, { held: true });
  await seed(page, { references: 2 });
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600]);
  await page.evaluate(() => window.similarityPending.shift()?.());
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600, 601]);
  await expect.poll(async () => Boolean((await stored(page)).find(photo => photo.id === 'similarity-0').similarityIndex)).toBe(true);
  const editor = await openEditor(page, 2);
  const suggestions = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(suggestions.getByRole('button', { name: 'Compare scenes and objects', exact: true })).toBeEnabled();
  await suggestions.getByRole('button', { name: 'Compare scenes and objects', exact: true }).click();
  // Manual comparison reuses the just-finished target and holds its remaining
  // reference while the saved target makes partial indexed results available.
  await page.evaluate(() => window.similarityPending.shift()?.());
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602]);
  await expect.poll(async () => Boolean((await stored(page)).find(photo => photo.id === 'similarity-1').similarityIndex)).toBe(true);
  await expect(suggestions.getByRole('button', { name: 'Cancel comparison', exact: true })).toBeVisible();
  const panel = await openJobs(page);
  await panel.getByRole('button', { name: 'Pause similarity scan', exact: true }).click();
  await jobs(page).getByRole('button', { name: 'Close', exact: true }).click();
  await finishAll(page);
  await expect(suggestions.getByRole('button', { name: 'Compare scenes and objects', exact: true })).toBeEnabled();
  await expect(suggestions.getByRole('button', { name: 'Use date: June 1970', exact: true })).toBeVisible();
  await openJobs(page);
  const catalogue = similarity(page).getByRole('progressbar', { name: 'Photo similarity progress', exact: true });
  const comparison = similarity(page).getByRole('progressbar', { name: 'Photo comparison progress', exact: true });
  await expect(catalogue).toHaveAttribute('value', '2');
  await expect(catalogue).toHaveAttribute('max', '3');
  await expect(comparison).toHaveAttribute('value', '2');
  await expect(comparison).toHaveAttribute('max', '2');
  await expect(similarity(page).getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602]);
});

test('removing a failed photo clears its similarity alert when the catalogue is complete', async ({ page }) => {
  await fakeWorkers(page, { failures: [601] });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.similarityStarts)).toEqual([600, 601, 602]);
  const panel = await openJobs(page);
  await expect(panel.getByRole('button', { name: 'Retry failed photos', exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toBeVisible();
  const editor = await openEditor(page, 2);
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await openJobs(page);
  const catalogue = similarity(page).getByRole('progressbar', { name: 'Photo similarity progress', exact: true });
  await expect(catalogue).toHaveAttribute('value', '2');
  await expect(catalogue).toHaveAttribute('max', '2');
  await expect(similarity(page).getByRole('button', { name: 'Retry failed photos', exact: true })).toHaveCount(0);
  await expect(similarity(page).getByRole('alert')).toHaveCount(0);
});
