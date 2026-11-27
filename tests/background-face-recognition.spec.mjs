import { test, expect } from '@playwright/test';

const embedding = index => Array.from({ length: 128 }, (_, position) => Number(index === position));
const face = index => ({ id: 'background-face', x: 10, y: 20, width: 20, height: 30, confidence: 0.99, embedding: embedding(index) });
const faces = [face(0), face(1)];
const background = page => page.getByRole('region', { name: 'Background face recognition', exact: true });
const jobs = page => page.getByRole('dialog', { name: 'Jobs', exact: true });

async function openBackground(page) {
  if (!await jobs(page).isVisible()) {
    const editor = page.getByRole('dialog', { name: 'Photo Details', exact: true });
    const trigger = await editor.isVisible() ? editor : page.locator('header');
    await trigger.getByRole('button', { name: 'Jobs', exact: true }).click();
  }
  return background(page);
}

const editorPanel = page => page.getByRole('dialog', { name: 'Photo Details', exact: true }).getByRole('region', { name: 'Face recognition', exact: true });

async function fakeWorker(page, { held = false, failures = [] } = {}) {
  await page.addInitScript(({ faces, held, failures }) => {
    const NativeWorker = window.Worker;
    window.backgroundStarts = [];
    window.backgroundStops = 0;
    window.backgroundPending = [];
    window.backgroundActive = 0;
    window.backgroundMaxActive = 0;
    window.backgroundFailures = failures;
    window.Worker = class {
      constructor(url, options) {
        this.recognition = String(url).includes('faceRecognition.worker');
        if (!this.recognition && !String(url).includes('faceDetection.worker')) return new NativeWorker(url, options);
      }
      postMessage(message) {
        const width = message.image.width;
        message.image.close();
        if (this.recognition) {
          window.backgroundStarts.push(width);
          this.pending = true;
          window.backgroundActive++;
          window.backgroundMaxActive = Math.max(window.backgroundMaxActive, window.backgroundActive);
        }
        const complete = () => {
          if (!this.pending && this.recognition) return;
          if (this.recognition) { this.pending = false; window.backgroundActive--; }
          if (this.stopped) return;
          this.onmessage?.({ data: this.recognition && window.backgroundFailures.includes(width) ? {
            type: 'error', message: 'Test inference failure',
          } : { type: 'result', faces: [faces[width === 622 ? 1 : 0]] } });
        };
        if (this.recognition && held) window.backgroundPending.push(complete);
        else setTimeout(complete, 30);
      }
      terminate() {
        if (this.stopped) return;
        if (this.recognition) {
          window.backgroundStops++;
          if (this.pending) { this.pending = false; window.backgroundActive--; }
        }
        this.stopped = true;
      }
    };
  }, { faces, held, failures });
}

async function seed(page, { named = true, paused = false, folder = false } = {}) {
  await page.goto('/');
  await page.evaluate(async ({ named, paused, folder }) => {
    const { storageService } = await import('/services/storageService.ts');
    localStorage.setItem('ancestry-lens-recognition-paused', String(paused));
    if (folder) {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('background-recognition-test', { create: true });
      window.showDirectoryPicker = async () => archive;
      storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
      if (!await storageService.connectFileSystem()) throw new Error('Test folder unavailable');
    }
    for (let index = 0; index < 3; index++) {
      const canvas = document.createElement('canvas'); canvas.width = 620 + index; canvas.height = 400;
      const context = canvas.getContext('2d'); context.fillStyle = ['#203050', '#405020', '#502040'][index]; context.fillRect(0, 0, canvas.width, canvas.height);
      await storageService.savePhoto({ id: `background-${index}`, originalUrl: canvas.toDataURL(), fileName: `background-${index}.png`,
        description: `Background photo ${index + 1}`, uploadDate: 3 - index,
        people: named && index === 0 ? ['Anna'] : [], faceTags: named && index === 0 ? [{ id: 'confirmed-anna', name: 'Anna', x: 20, y: 35 }] : [],
        tags: [], dateOfPhoto: '', isRestoring: false,
      });
    }
    await storageService.saveFamilyTree({ rootId: 'anna', people: [{ id: 'anna', name: 'Anna' }], families: [] });
  }, { named, paused, folder });
  await page.reload();
  await expect(page.getByRole('img', { name: 'Background photo 1', exact: true })).toBeVisible();
}

async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    await storageService.writeQueue;
    if (storageService.getSettings().storageType === 'filesystem') {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('background-recognition-test');
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
async function openEditor(page, index = 1) {
  if (await jobs(page).isVisible()) await jobs(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('img', { name: `Background photo ${index}`, exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  return page.getByRole('dialog', { name: 'Photo Details', exact: true });
}
async function release(page, starts) {
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(starts);
  await page.evaluate(() => window.backgroundPending.shift()?.());
}

for (const folder of [false, true]) {
  test(`automatically indexes every photo sequentially and reuses saved results (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
    await fakeWorker(page);
    await seed(page, { folder });
    await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
    expect(await page.evaluate(() => window.backgroundStarts)).toEqual([620, 621, 622]);
    expect(await page.evaluate(() => window.backgroundMaxActive)).toBe(1);
    await expect(await openBackground(page)).toContainText(/3\s*\/\s*3/);
    const records = await stored(page);
    expect(records.find(photo => photo.id === 'background-1').faceTags).toEqual([]);
    expect(records.find(photo => photo.id === 'background-2').faceRecognition).toBeTruthy();
    await page.reload();
    await expect(await openBackground(page)).toContainText(/3\s*\/\s*3/);
    expect(await page.evaluate(() => window.backgroundStarts)).toEqual([]);
  });
}

test('an opened photo is prioritized after the active inference without concurrency', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts)).toEqual([620]);
  await openEditor(page, 3);
  await release(page, 1);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts)).toEqual([620, 622]);
  await release(page, 2);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts)).toEqual([620, 622, 621]);
  await release(page, 3);
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  expect(await page.evaluate(() => window.backgroundMaxActive)).toBe(1);
});

test('pause cancels active work, persists after reload, and resumes missing photos', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await release(page, 1);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(2);
  await (await openBackground(page)).getByRole('button', { name: 'Pause recognition', exact: true }).click();
  await expect((await openBackground(page)).getByRole('button', { name: 'Resume recognition', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ancestry-lens-recognition-paused'))).toBe('true');
  await page.evaluate(() => window.backgroundPending.forEach(complete => complete()));
  expect((await stored(page)).filter(photo => photo.faceRecognition)).toHaveLength(1);
  await page.reload();
  await expect((await openBackground(page)).getByRole('button', { name: 'Resume recognition', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([]);
  await (await openBackground(page)).getByRole('button', { name: 'Resume recognition', exact: true }).click();
  for (let count = 1; count <= 2; count++) await release(page, count);
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([621, 622]);
});

test('closing and navigating the editor keeps background inference running', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(1);
  const editor = await openEditor(page);
  await page.keyboard.press('ArrowRight');
  await expect(editor.locator('textarea')).toHaveValue('Background photo 2');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate(() => window.backgroundActive)).toBe(1);
  expect(await page.evaluate(() => window.backgroundStops)).toBe(0);
  for (let count = 1; count <= 3; count++) await release(page, count);
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
});

test('newly confirmed references update other photo suggestions without another inference', async ({ page }) => {
  await fakeWorker(page);
  await seed(page, { named: false });
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  const editor = await openEditor(page);
  const panel = editorPanel(page);
  await panel.getByRole('button', { name: 'Detected face 1 · Unknown', exact: true }).click();
  await editor.getByRole('option', { name: 'Anna', exact: true }).click();
  await expect.poll(async () => (await stored(page)).find(photo => photo.id === 'background-0').faceTags.length).toBe(1);
  await page.keyboard.press('Escape');
  await editor.getByRole('heading', { name: 'Photo Details', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await expect(editor.locator('textarea')).toHaveValue('Background photo 2');
  await expect(editorPanel(page).getByRole('button', { name: 'Confirm name: Anna', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.backgroundStarts.length)).toBe(3);
  expect((await stored(page)).find(photo => photo.id === 'background-1').faceTags).toEqual([]);
});

test('a failed photo does not block later photos and can be retried explicitly', async ({ page }) => {
  await fakeWorker(page, { failures: [621] });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(3);
  await expect((await openBackground(page)).getByRole('button', { name: 'Retry failed photos', exact: true })).toBeVisible();
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(2);
  await page.evaluate(() => { window.backgroundFailures = []; });
  await (await openBackground(page)).getByRole('button', { name: 'Retry failed photos', exact: true }).click();
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([620, 621, 622, 621]);
});

test('metadata edited during automatic inference survives the signature write', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(1);
  const editor = await openEditor(page);
  await editor.locator('textarea').fill('Latest description during background matching');
  await release(page, 1);
  await expect.poll(async () => (await stored(page)).find(photo => photo.id === 'background-0').faceRecognition).toBeTruthy();
  expect((await stored(page)).find(photo => photo.id === 'background-0').description).toBe('Latest description during background matching');
});

test('clearing signatures pauses inference and ignores pending results', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await release(page, 1);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(2);
  const editor = await openEditor(page);
  await editorPanel(page).getByRole('button', { name: 'Clear saved face signatures from this archive', exact: true }).click();
  await expect.poll(async () => (await stored(page)).every(photo => !photo.faceRecognition)).toBe(true);
  await page.evaluate(() => window.backgroundPending.forEach(complete => complete()));
  expect(await page.evaluate(() => localStorage.getItem('ancestry-lens-recognition-paused'))).toBe('true');
  expect((await stored(page)).find(photo => photo.id === 'background-0').faceTags).toEqual([{ id: 'confirmed-anna', name: 'Anna', x: 20, y: 35 }]);
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect((await openBackground(page)).getByRole('button', { name: 'Resume recognition', exact: true })).toBeVisible();
  await page.reload();
  await expect((await openBackground(page)).getByRole('button', { name: 'Resume recognition', exact: true })).toBeVisible();
  expect((await stored(page)).every(photo => !photo.faceRecognition)).toBe(true);
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([]);
});

test('background progress and automatic suggestions fit desktop and mobile', async ({ page }, testInfo) => {
  await fakeWorker(page);
  await seed(page);
  await expect(await openBackground(page)).toContainText(/3\s*\/\s*3/);
  await page.screenshot({ path: testInfo.outputPath('background-desktop.png') });
  const editor = await openEditor(page, 2);
  await expect(editorPanel(page).getByRole('button', { name: 'Confirm name: Anna', exact: true })).toBeVisible();
  await editorPanel(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('automatic-suggestions-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await editorPanel(page).scrollIntoViewIfNeeded();
  await expect(editorPanel(page).getByRole('button', { name: 'Confirm name: Anna', exact: true })).toBeVisible();
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('automatic-suggestions-mobile.png') });
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect((await openBackground(page)).getByRole('button', { name: 'Pause recognition', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('background-mobile.png') });
});


test('an imported photo joins the automatic queue without reindexing cached photos', async ({ page }) => {
  await fakeWorker(page);
  await seed(page);
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 624; canvas.height = 400;
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL();
  });
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'new-background.png', mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') });
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(4);
  await expect(await openBackground(page)).toContainText(/4\s*\/\s*4/);
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([620, 621, 622, 624]);
});

test('replacing a photo cancels its old inference and queues the new original', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(1);
  const editor = await openEditor(page);
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 623; canvas.height = 400;
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL();
  });
  page.once('dialog', dialog => dialog.accept());
  await editor.locator('input[type=file]').setInputFiles({ name: 'better-original.png', mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') });
  await expect(editor.getByRole('status').filter({ hasText: 'Original replaced' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.backgroundStarts)).toEqual([620, 623]);
  await page.evaluate(() => window.backgroundPending.shift()());
  expect((await stored(page)).find(photo => photo.id === 'background-0').faceRecognition).toBeUndefined();
  for (let count = 2; count <= 4; count++) await release(page, count);
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([620, 623, 621, 622]);
  expect(await page.evaluate(() => window.backgroundMaxActive)).toBe(1);
});

test('switching archives discards a held result even when a photo ID is reused', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(1);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const archive = await root.getDirectoryHandle('background-recognition-test', { create: true });
    await archive.getDirectoryHandle('images', { create: true });
    const canvas = document.createElement('canvas'); canvas.width = 625; canvas.height = 400;
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
    const writer = await (await archive.getFileHandle('ancestry_db.json', { create: true })).createWritable();
    await writer.write(JSON.stringify([{ id: 'background-0', originalUrl: canvas.toDataURL(), fileName: 'other-archive.png',
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
  await expect.poll(() => page.evaluate(() => window.backgroundStarts)).toEqual([620, 625]);
  await page.evaluate(() => window.backgroundPending.shift()());
  expect((await stored(page))[0].faceRecognition).toBeUndefined();
  await release(page, 2);
  await expect.poll(async () => (await stored(page))[0].faceRecognition).toBeTruthy();
  expect((await stored(page))[0].description).toBe('Other archive photo');
  expect(await page.evaluate(() => window.backgroundMaxActive)).toBe(1);
  const old = await page.evaluate(async () => {
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    return new BrowserPhotoStorage().loadPhotos();
  });
  expect(old.every(photo => !photo.faceRecognition)).toBe(true);
});


test('recognition starts automatically when no pause preference has been saved', async ({ page }) => {
  await fakeWorker(page);
  await seed(page, { paused: true });
  await page.evaluate(() => localStorage.removeItem('ancestry-lens-recognition-paused'));
  await page.reload();
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  await expect((await openBackground(page)).getByRole('button', { name: 'Pause recognition', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([620, 621, 622]);
});


test('a failed original replacement resumes recognition of the preserved source', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(1);
  const editor = await openEditor(page);
  const original = (await stored(page)).find(photo => photo.id === 'background-0').originalUrl;
  const replacement = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 623; canvas.height = 400;
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
    const replacement = canvas.toDataURL();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value?.id === 'background-0' && value.originalUrl === replacement) {
        IDBObjectStore.prototype.put = put;
        throw new DOMException('Test replacement write failure', 'QuotaExceededError');
      }
      return put.call(this, value, ...args);
    };
    return replacement;
  });
  page.once('dialog', dialog => dialog.accept());
  await editor.locator('input[type=file]').setInputFiles({ name: 'failed-replacement.png', mimeType: 'image/png', buffer: Buffer.from(replacement.split(',')[1], 'base64') });
  await expect(editor.getByRole('alert')).toContainText('Your photo and metadata are unchanged');
  await expect.poll(() => page.evaluate(() => window.backgroundStarts)).toEqual([620, 620]);
  expect((await stored(page)).find(photo => photo.id === 'background-0').originalUrl).toBe(original);
  await page.evaluate(() => window.backgroundPending.shift()());
  for (let count = 2; count <= 4; count++) await release(page, count);
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([620, 620, 621, 622]);
});

test('deleting the active photo discards its result and continues with remaining photos', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(1);
  const editor = await openEditor(page);
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts)).toEqual([620, 621]);
  await page.evaluate(() => window.backgroundPending.shift()());
  for (let count = 2; count <= 3; count++) await release(page, count);
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(2);
  expect((await stored(page)).some(photo => photo.id === 'background-0')).toBe(false);
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([620, 621, 622]);
  expect(await page.evaluate(() => window.backgroundMaxActive)).toBe(1);
});


test('a failed deletion resumes recognition without losing the photo', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts.length)).toBe(1);
  const editor = await openEditor(page);
  await page.evaluate(() => {
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (...args) {
      IDBObjectStore.prototype.delete = remove;
      throw new DOMException('Test deletion failure', 'NotAllowedError');
    };
  });
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('The photo could not be deleted');
  await expect.poll(() => page.evaluate(() => window.backgroundStarts)).toEqual([620, 620]);
  expect(await stored(page)).toHaveLength(3);
  await page.evaluate(() => window.backgroundPending.shift()());
  for (let count = 2; count <= 4; count++) await release(page, count);
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition).length).toBe(3);
  expect((await stored(page)).find(photo => photo.id === 'background-0').faceTags[0].name).toBe('Anna');
});


test('Jobs hides recognition until opened and restores focus after dismissal', async ({ page }) => {
  await fakeWorker(page, { held: true });
  await seed(page);
  await expect.poll(() => page.evaluate(() => window.backgroundStarts)).toEqual([620]);
  const trigger = page.locator('header').getByRole('button', { name: 'Jobs', exact: true });
  await expect(trigger).toBeVisible();
  await expect(jobs(page)).toBeHidden();
  await expect(background(page)).toBeHidden();
  await trigger.click();
  await expect(jobs(page)).toBeVisible();
  await expect(background(page)).toContainText(/0\s*\/\s*3/);
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab');
    expect(await jobs(page).evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(jobs(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await jobs(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(2, 2);
  await expect(jobs(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.backgroundStarts)).toEqual([620]);
  expect(await page.evaluate(() => window.backgroundActive)).toBe(1);
});
