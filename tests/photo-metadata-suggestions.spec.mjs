import { test, expect } from '@playwright/test';

async function seed(page, { folder = false, language = 'en', references = true } = {}) {
  await page.goto('/');
  await page.evaluate(async ({ folder, language, references }) => {
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ language, storageType: folder ? 'filesystem' : 'local' });
    if (folder) {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('metadata-suggestions-archive', { create: true });
      window.showDirectoryPicker = async () => archive;
      if (!await storageService.connectFileSystem()) throw new Error('Test archive unavailable');
    }
    const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 240;
    const context = canvas.getContext('2d');
    const scene = alternate => {
      context.fillStyle = alternate ? '#191b4c' : '#b4a77e'; context.fillRect(0, 0, 360, 240);
      context.fillStyle = alternate ? '#c48f35' : '#496448'; context.fillRect(0, 145, 360, 95);
      context.fillStyle = '#eee2bb'; context.fillRect(alternate ? 195 : 22, 32, 118, 132);
      context.fillStyle = '#593831'; context.fillRect(alternate ? 219 : 52, 66, 30, 35);
      context.fillRect(alternate ? 266 : 99, 66, 26, 35);
      context.fillStyle = '#283d29'; context.beginPath(); context.arc(alternate ? 62 : 276, 70, 52, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#573d21'; context.fillRect(alternate ? 56 : 270, 90, 12, 100);
      context.strokeStyle = '#eee'; context.lineWidth = 6; context.beginPath(); context.moveTo(155, 160); context.lineTo(alternate ? 10 : 330, 233); context.stroke();
      return canvas.toDataURL();
    };
    const originalUrl = scene(false), unrelated = scene(true);
    const base = { uploadDate: 100, description: '', dateOfPhoto: '', location: '', people: [], tags: [], faceTags: [], isRestoring: false };
    await storageService.savePhoto({ ...base, id: 'suggestion-target', fileName: 'img021.png', originalUrl,
      restoredUrl: unrelated, description: 'Uncatalogued garden photo', people: ['Anna'], tags: ['family'],
      faceTags: [{ id: 'face-anna', name: 'Anna', x: 30, y: 40 }] });
    if (references) {
      await storageService.savePhoto({ ...base, id: 'suggestion-reference', fileName: 'img020.png', originalUrl,
        dateOfPhoto: '1968-07', location: 'Grandma’s garden', description: 'Known garden reference' });
      await storageService.savePhoto({ ...base, id: 'suggestion-unrelated', fileName: 'other-event.png', originalUrl: unrelated,
        dateOfPhoto: '1990-06-12', location: 'Other town', description: 'Unrelated reference' });
    }
  }, { folder, language, references });
  await page.reload();
  await page.getByRole('img', { name: 'Uncatalogued garden photo', exact: true }).click();
  await page.getByRole('button', { name: language === 'sk' ? 'Vylepšiť / Upraviť' : 'Enhance / Edit', exact: true }).click();
  return page.getByRole('dialog', { name: language === 'sk' ? 'Detaily fotky' : 'Photo Details', exact: true });
}

async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    // Queue raw reads with writes; hydrating the folder here would replace the
    // original-source cache while the editor still holds its live Blob URLs.
    const read = storageService.writeQueue.then(async () => {
      if (storageService.getSettings().storageType === 'filesystem') {
        const root = await navigator.storage.getDirectory();
        const archive = await root.getDirectoryHandle('metadata-suggestions-archive');
        return JSON.parse(await (await (await archive.getFileHandle('ancestry_db.json')).getFile()).text());
      }
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('ancestry-lens-archive', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('photos', 'readonly');
          const records = transaction.objectStore('photos').getAll();
          transaction.oncomplete = () => { database.close(); resolve(records.result); };
          transaction.onabort = () => { database.close(); reject(transaction.error); };
        };
      });
    });
    storageService.writeQueue = read.then(() => {}, () => {});
    return (await read).find(photo => photo.id === 'suggestion-target');
  });
}

for (const folder of [false, true]) test(`local date and place suggestions need acceptance and preserve metadata (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
  let externalCalls = 0;
  await page.route('https://generativelanguage.googleapis.com/**', route => { externalCalls++; return route.abort(); });
  const editor = await seed(page, { folder });
  const region = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(region.getByRole('button', { name: 'Use date: July 1968', exact: true })).toBeVisible();
  await expect(region.getByRole('button', { name: 'Use place: Grandma’s garden', exact: true })).toBeVisible();
  expect(await stored(page)).toMatchObject({ dateOfPhoto: '', location: '' });
  expect(externalCalls).toBe(0);
  await region.getByRole('button', { name: 'Use date: July 1968', exact: true }).click();
  await expect.poll(async () => (await stored(page)).dateOfPhoto).toBe('1968-07');
  await region.getByRole('button', { name: 'Use place: Grandma’s garden', exact: true }).click();
  await expect.poll(async () => (await stored(page)).location).toBe('Grandma’s garden');
  expect(await stored(page)).toMatchObject({ description: 'Uncatalogued garden photo', people: ['Anna'], tags: ['family'],
    faceTags: [{ id: 'face-anna', name: 'Anna', x: 30, y: 40 }], dateOfPhoto: '1968-07' });
  await page.reload();
  expect(await stored(page)).toMatchObject({ dateOfPhoto: '1968-07', location: 'Grandma’s garden' });
});

test('an archive without reference metadata explains how to get suggestions', async ({ page }) => {
  const editor = await seed(page, { references: false });
  const region = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(region.getByRole('button', { name: /^Use (date|place):/ })).toHaveCount(0);
  await expect(region).toContainText(/date or place/i);
  await expect(region.getByRole('button', { name: 'Compare scenes and objects', exact: true })).toHaveCount(0);
});

test('manual place edits remain intact until refreshed suggestions are explicitly accepted', async ({ page }) => {
  const editor = await seed(page);
  const region = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(region.getByRole('button', { name: 'Use place: Grandma’s garden', exact: true })).toBeVisible();
  await editor.getByPlaceholder("e.g. Grandma's Garden, Paris").fill('My manually entered place');
  await expect.poll(async () => (await stored(page)).location).toBe('My manually entered place');
  await region.getByRole('button', { name: 'Replace place: Grandma’s garden', exact: true }).click();
  await expect(region.getByRole('alert')).toContainText('Refresh suggestions');
  expect((await stored(page)).location).toBe('My manually entered place');
  await region.getByRole('button', { name: 'Refresh suggestions', exact: true }).click();
  await expect(region.getByRole('button', { name: 'Replace place: Grandma’s garden', exact: true })).toBeEnabled();
  await region.getByRole('button', { name: 'Replace place: Grandma’s garden', exact: true }).click();
  await expect.poll(async () => (await stored(page)).location).toBe('Grandma’s garden');
});

test('Slovak suggestions preserve a month and year without adding a day', async ({ page }) => {
  const editor = await seed(page, { language: 'sk' });
  const region = editor.getByRole('region', { name: 'Návrhy dátumu a miesta', exact: true });
  await expect(region.getByRole('button', { name: 'Použiť dátum: júl 1968', exact: true })).toBeVisible();
  await region.getByRole('button', { name: 'Použiť dátum: júl 1968', exact: true }).click();
  await expect.poll(async () => (await stored(page)).dateOfPhoto).toBe('1968-07');
});

test('scene comparison runs locally on request and still requires acceptance', async ({ page }) => {
  test.setTimeout(90000);
  const external = [];
  page.on('request', request => {
    if (request.url().startsWith('http') && !['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  const editor = await seed(page);
  const region = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(region.getByRole('button', { name: 'Use date: July 1968', exact: true })).toBeVisible();
  await region.getByRole('button', { name: 'Compare scenes and objects', exact: true }).click();
  await editor.getByRole('button', { name: 'Jobs', exact: true }).click();
  const jobs = page.getByRole('dialog', { name: 'Jobs', exact: true });
  await expect(jobs.getByRole('region', { name: 'Photo similarity', exact: true })).toContainText('Scenes and objects compared on this device', { timeout: 60000 });
  await jobs.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(region.getByRole('button', { name: 'Use date: July 1968', exact: true })).toBeVisible();
  await expect(region.getByRole('button', { name: 'Use place: Grandma’s garden', exact: true })).toBeVisible();
  expect(await stored(page)).toMatchObject({ dateOfPhoto: '', location: '' });
  expect(external).toEqual([]);
});

test('cancelling scene comparison stops its worker and retains local suggestions', async ({ page }) => {
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.sceneWorkers = 0; window.sceneTerminations = 0;
    window.Worker = class extends OriginalWorker {
      constructor(url, options) {
        if (String(url).includes('sceneEmbedding.worker')) {
          window.sceneWorkers++;
          return { postMessage() {}, terminate() { window.sceneTerminations++; } };
        }
        super(url, options);
      }
    };
  });
  const editor = await seed(page);
  const region = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(region.getByRole('button', { name: 'Use date: July 1968', exact: true })).toBeVisible();
  await region.getByRole('button', { name: 'Compare scenes and objects', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sceneWorkers)).toBe(1);
  await region.getByRole('button', { name: 'Cancel comparison', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sceneTerminations)).toBe(1);
  await expect(region.getByRole('button', { name: 'Compare scenes and objects', exact: true })).toBeEnabled();
  await region.getByRole('button', { name: 'Use date: July 1968', exact: true }).click();
  await expect.poll(async () => (await stored(page)).dateOfPhoto).toBe('1968-07');
});

test('suggestion evidence fits a mobile editor', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const editor = await seed(page);
  const region = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(region.getByRole('button', { name: 'Use date: July 1968', exact: true })).toBeVisible();
  await region.scrollIntoViewIfNeeded();
  const bounds = await region.boundingBox();
  expect(bounds.width).toBeLessThanOrEqual(360);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath('metadata-suggestions-mobile.png') });
});


test('Jobs shows live similarity progress above the editor and isolates keyboard navigation', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.scenePending = [];
    window.sceneHeld = true;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (String(url).includes('sceneEmbedding.worker')) return {
          postMessage({ image }) {
            image.close();
            const complete = () => this.onmessage?.({ data: { type: 'result', descriptor: {
              embedding: [1, ...Array(1023).fill(0)],
              gray: Array.from({ length: 256 }, (_, index) => index % 2 ? 1 : -1),
              mean: 128, deviation: 50, saturation: 0.1, aspect: 1.5,
            } } });
            if (window.sceneHeld) window.scenePending.push(complete);
            else setTimeout(complete, 10);
          },
          terminate() {},
        };
        super(url, options);
      }
    };
  });
  const editor = await seed(page);
  const region = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(region.getByRole('button', { name: 'Use date: July 1968', exact: true })).toBeVisible();
  const originalDescription = await editor.locator('textarea').inputValue();
  await region.getByRole('button', { name: 'Compare scenes and objects', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scenePending.length)).toBe(1);
  await expect(region.getByText(/Compared \d+ of \d+ photos/)).toHaveCount(0);
  const trigger = editor.getByRole('button', { name: 'Jobs', exact: true });
  await trigger.click();
  const jobs = page.getByRole('dialog', { name: 'Jobs', exact: true });
  const similarity = jobs.getByRole('region', { name: 'Photo similarity', exact: true });
  const progress = similarity.getByRole('progressbar', { name: 'Photo comparison progress', exact: true });
  await expect(similarity).toContainText('img021.png');
  await expect(progress).toHaveAttribute('value', '0');
  await expect(progress).toHaveAttribute('max', '2');
  await page.keyboard.press('ArrowRight');
  await expect(editor.locator('textarea')).toHaveValue(originalDescription);
  await page.evaluate(() => {
    window.sceneHeld = false;
    window.scenePending.shift()?.();
  });
  await expect(progress).toHaveAttribute('value', '2');
  await expect(similarity).toContainText('Scenes and objects compared on this device');
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await jobs.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  expect(await jobs.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('jobs-similarity-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(jobs).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(editor).toBeVisible();
  await expect(editor.locator('textarea')).toHaveValue(originalDescription);
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('header').getByRole('button', { name: 'Jobs', exact: true }).click();
  await expect(jobs.getByText('Open a photo to compare it with your archive.', { exact: true })).toHaveCount(0);
  await expect(jobs.getByRole('progressbar', { name: 'Photo comparison progress', exact: true })).toHaveCount(0);
  await expect(jobs.getByRole('region', { name: 'Background face recognition', exact: true })).toContainText('Face signatures are saved with your archive. Scanning resumes when you reopen the app.');
});


async function fakeSceneDescriptors(page, deviation = 50) {
  await page.addInitScript(deviation => {
    const NativeWorker = window.Worker;
    window.sceneRequests = 0;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (String(url).includes('sceneEmbedding.worker')) return {
          postMessage({ image }) {
            image.close();
            window.sceneRequests++;
            setTimeout(() => this.onmessage?.({ data: { type: 'result', descriptor: {
              embedding: [1, ...Array(1023).fill(0)],
              gray: Array.from({ length: 256 }, (_, index) => index % 2 ? 1 : -1),
              mean: 128, deviation, saturation: 0.1, aspect: 1.5,
            } } }), 10);
          },
          terminate() {},
        };
        super(url, options);
      }
    };
  }, deviation);
}

test('Jobs clears a visual comparison error after a successful scene comparison', async ({ page }) => {
  await fakeSceneDescriptors(page);
  await page.route('**/services/photoSimilarity.ts*', async route => {
    const response = await route.fetch();
    const original = await response.text();
    await route.fulfill({ response, body: original + '\n' +
      'findSimilarPhotos = async () => {\n' +
      '  window.visualComparisonAttempts = (window.visualComparisonAttempts || 0) + 1;\n' +
      '  throw new Error("Test visual comparison failure");\n' +
      '};\n' });
  });
  const editor = await seed(page);
  await editor.getByRole('button', { name: 'Jobs', exact: true }).click();
  const jobs = page.getByRole('dialog', { name: 'Jobs', exact: true });
  const similarity = jobs.getByRole('region', { name: 'Photo similarity', exact: true });
  await expect(similarity.getByRole('alert')).toContainText('Photo comparison could not finish');
  await jobs.getByRole('button', { name: 'Close', exact: true }).click();
  const region = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await region.getByRole('button', { name: 'Compare scenes and objects', exact: true }).click();
  await editor.getByRole('button', { name: 'Jobs', exact: true }).click();
  await expect(similarity).toContainText('Scenes and objects compared on this device');
  await expect(similarity.getByRole('alert')).toHaveCount(0);
  await expect(similarity.getByRole('progressbar', { name: 'Photo comparison progress', exact: true })).toHaveAttribute('value', '2');
  expect(await page.evaluate(() => window.visualComparisonAttempts)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.sceneRequests)).toBeGreaterThan(0);
});

test('Jobs completes scene progress when the target descriptor has too little visual variation', async ({ page }) => {
  // Exercise the real scene-comparison early return without loading model assets.
  await fakeSceneDescriptors(page, 0);
  const editor = await seed(page);
  const region = editor.getByRole('region', { name: 'Date and place suggestions', exact: true });
  await expect(region.getByRole('button', { name: 'Compare scenes and objects', exact: true })).toBeEnabled();
  await region.getByRole('button', { name: 'Compare scenes and objects', exact: true }).click();
  await editor.getByRole('button', { name: 'Jobs', exact: true }).click();
  const similarity = page.getByRole('dialog', { name: 'Jobs', exact: true }).getByRole('region', { name: 'Photo similarity', exact: true });
  await expect(similarity).toContainText('Scenes and objects compared on this device');
  const progress = similarity.getByRole('progressbar', { name: 'Photo comparison progress', exact: true });
  await expect(progress).toHaveAttribute('value', '2');
  await expect(progress).toHaveAttribute('max', '2');
  await expect(similarity.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.sceneRequests)).toBe(1);
});
