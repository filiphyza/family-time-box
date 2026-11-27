import { test, expect } from '@playwright/test';
import UTIF from 'utif2';

const editor = page => page.getByRole('dialog', { name: 'Photo Details', exact: true });

async function fakeWorkers(page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class {
      constructor(url, options) {
        this.scene = String(url).includes('sceneEmbedding.worker');
        this.face = String(url).includes('faceRecognition.worker');
        if (!this.scene && !this.face) return new NativeWorker(url, options);
      }
      postMessage({ image }) {
        image.close();
        setTimeout(() => {
          if (this.stopped) return;
          this.onmessage?.({ data: this.scene ? { type: 'result', descriptor: {
            embedding: Array.from({ length: 1024 }, (_, index) => Number(index === 0)),
            gray: Array.from({ length: 256 }, (_, index) => index % 2 ? 1 : -1),
            mean: 128, deviation: 50, saturation: 0.1, aspect: 1.5,
          } } : { type: 'result', faces: [{
            id: 'matched-face', x: 10, y: 20, width: 20, height: 30, confidence: 0.99,
            embedding: Array.from({ length: 128 }, (_, index) => Number(index === 0)),
          }] } });
        }, 20);
      }
      terminate() { this.stopped = true; }
    };
  });
}

async function seed(page, { mode, folder = false, uncertain = false } = {}) {
  await fakeWorkers(page);
  await page.goto('/');
  const image = await page.evaluate(async ({ mode, folder, uncertain }) => {
    const { storageService } = await import('/services/storageService.ts');
    localStorage.setItem('ancestry-lens-recognition-paused', 'false');
    localStorage.setItem('ancestry-lens-similarity-paused', 'false');
    storageService.saveSettings({ language: 'en', storageType: folder ? 'filesystem' : 'local', ...(mode ? { suggestionMode: mode } : {}) });
    if (folder) {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('automatic-suggestions-test', { create: true });
      window.showDirectoryPicker = async () => archive;
      if (!await storageService.connectFileSystem()) throw new Error('Test archive unavailable');
    }
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext('2d');
    context.fillStyle = '#30472a'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#cfb678'; context.fillRect(40, 40, 120, 180);
    const originalUrl = canvas.toDataURL();
    await storageService.savePhoto({
      id: 'reference', originalUrl, fileName: 'reference.png', uploadDate: 1, description: 'Confirmed reference',
      people: ['Anna'], tags: [], faceTags: [{ id: 'anna-tag', name: 'Anna', personId: 'anna', x: 20, y: 35, ...(uncertain ? { aiSuggested: true } : {}) }],
      dateOfPhoto: '1970-06', location: 'Family garden', isRestoring: false,
      ...(uncertain ? { aiMetadata: {
        dateOfPhoto: { value: '1970-06', sourcePhotoIds: ['removed-source'] },
        location: { value: 'Family garden', sourcePhotoIds: ['removed-source'] },
      } } : {}),
    });
    await storageService.savePhoto({ id: 'existing-blank', originalUrl, fileName: 'existing.png', uploadDate: 2,
      description: 'Existing blank photo', people: [], tags: [], faceTags: [], dateOfPhoto: '', isRestoring: false });
    await storageService.saveFamilyTree({ rootId: 'anna', people: [{ id: 'anna', name: 'Anna' }], families: [] });
    return originalUrl.split(',')[1];
  }, { mode, folder, uncertain });
  await page.reload();
  await expect(page.getByRole('img', { name: 'Confirmed reference', exact: true })).toBeVisible();
  return Buffer.from(image, 'base64');
}

async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const read = storageService.writeQueue.then(async () => {
    if (storageService.getSettings().storageType === 'filesystem') {
      const archive = await (await navigator.storage.getDirectory()).getDirectoryHandle('automatic-suggestions-test');
      return JSON.parse(await (await (await archive.getFileHandle('ancestry_db.json')).getFile()).text());
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ancestry-lens-archive', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('photos', 'readonly');
        const records = transaction.objectStore('photos').getAll();
        transaction.oncomplete = () => { db.close(); resolve(records.result); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
    });
    storageService.writeQueue = read.then(() => {}, () => {});
    return read;
  });
}

async function upload(page, buffer, name = 'new-upload.png') {
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer });
  await expect(page.getByRole('status')).toContainText('Import finished');
  await expect.poll(async () => (await stored(page)).find(photo => photo.fileName === name)?.similarityIndex).toBeTruthy();
  await expect.poll(async () => (await stored(page)).find(photo => photo.fileName === name)?.faceRecognition).toBeTruthy();
  return (await stored(page)).find(photo => photo.fileName === name);
}

async function openUploaded(page) {
  await page.getByRole('img', { name: 'Family Photo', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  return editor(page);
}

test('manual remains the default and upload leaves suggestions for review', async ({ page }) => {
  const image = await seed(page);
  const uploaded = await upload(page, image);
  expect(uploaded.dateOfPhoto).toBe('');
  expect(uploaded.location || '').toBe('');
  expect(uploaded.people).toEqual([]);
  expect(uploaded.faceTags).toEqual([]);
  expect(uploaded.autoSuggestions).toBeUndefined();
  const details = await openUploaded(page);
  await expect(details.getByRole('button', { name: 'Confirm name: Anna', exact: true })).toHaveCount(1);
  await expect(details.getByRole('button', { name: /^Use date:/ })).toBeVisible();
});

for (const folder of [false, true]) {
  test(`automatic upload applies marked suggestions and survives reload (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
    const image = await seed(page, { mode: 'automatic', folder });
    await upload(page, image);
    await expect.poll(async () => {
      const photo = (await stored(page)).find(item => item.fileName === 'new-upload.png');
      return { date: photo.dateOfPhoto, place: photo.location, names: photo.people };
    }).toEqual({ date: '1970-06', place: 'Family garden', names: ['Anna'] });
    const records = await stored(page), uploaded = records.find(photo => photo.fileName === 'new-upload.png');
    expect(uploaded.faceTags).toHaveLength(1);
    expect(uploaded.faceTags[0]).toMatchObject({ name: 'Anna', personId: 'anna', aiSuggested: true, aiAddedPerson: true });
    expect(uploaded.aiMetadata).toEqual({
      dateOfPhoto: { value: '1970-06', sourcePhotoIds: ['reference'] },
      location: { value: 'Family garden', sourcePhotoIds: ['reference'] },
    });
    expect(records.find(photo => photo.id === 'existing-blank')).toMatchObject({ dateOfPhoto: '', people: [], faceTags: [] });
    expect(records.find(photo => photo.id === 'reference').aiMetadata).toBeUndefined();
    await page.reload();
    const galleryCard = page.locator('.group').filter({ has: page.getByRole('img', { name: 'Family Photo', exact: true }) }).first();
    await expect(galleryCard.getByLabel('AI suggested', { exact: true }).first()).toBeVisible();
    await page.getByRole('img', { name: 'Family Photo', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'Photo viewer', exact: true });
    await expect(viewer.getByLabel('AI suggested', { exact: true })).toHaveCount(3);
    await viewer.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
    const details = editor(page);
    await expect(details.getByRole('button', { name: 'Confirm date', exact: true })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Confirm place', exact: true })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Confirm name: Anna', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await details.getByRole('button', { name: 'Confirm date', exact: true }).scrollIntoViewIfNeeded();
    await expect(details).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('automatic-suggestions-mobile.png') });
    await details.getByRole('button', { name: 'Confirm name: Anna', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('automatic-suggestions-people-mobile.png') });
  });
}

test('setting persists and only affects subsequent uploads', async ({ page }) => {
  const image = await seed(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Manual review', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Apply automatically on upload', exact: true }).check();
  await page.screenshot({ path: test.info().outputPath('automatic-suggestions-settings.png') });
  await page.getByRole('button', { name: 'Save Configuration', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ancestry-lens-settings')).suggestionMode)).toBe('automatic');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Apply automatically on upload', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Manual review', exact: true }).check();
  await page.getByRole('button', { name: 'Save Configuration', exact: true }).click();
  await page.reload();
  const uploaded = await upload(page, image);
  expect(uploaded.faceTags).toEqual([]);
  expect(uploaded.dateOfPhoto).toBe('');
  expect((await stored(page)).find(photo => photo.id === 'existing-blank').faceTags).toEqual([]);
});

test('confirming or editing AI values clears their tentative markers permanently', async ({ page }) => {
  const image = await seed(page, { mode: 'automatic' });
  await upload(page, image);
  await expect.poll(async () => (await stored(page)).find(photo => photo.fileName === 'new-upload.png')?.aiMetadata?.location).toBeTruthy();
  const details = await openUploaded(page);
  await details.getByRole('button', { name: 'Confirm date', exact: true }).click();
  await details.getByRole('button', { name: 'Confirm name: Anna', exact: true }).click();
  await details.getByPlaceholder("e.g. Grandma's Garden, Paris").fill('Prague');
  await expect.poll(async () => {
    const photo = (await stored(page)).find(item => item.fileName === 'new-upload.png');
    return { date: photo.dateOfPhoto, location: photo.location, dateAI: Boolean(photo.aiMetadata?.dateOfPhoto), placeAI: Boolean(photo.aiMetadata?.location), faceAI: Boolean(photo.faceTags[0]?.aiSuggested) };
  }).toEqual({ date: '1970-06', location: 'Prague', dateAI: false, placeAI: false, faceAI: false });
  await page.reload();
  await openUploaded(page);
  await expect(editor(page).getByRole('button', { name: 'Confirm date', exact: true })).toHaveCount(0);
  await expect(editor(page).getByRole('button', { name: 'Confirm place', exact: true })).toHaveCount(0);
  await expect(editor(page).getByRole('button', { name: 'Confirm name: Anna', exact: true })).toHaveCount(0);
});

test('unconfirmed AI values never become reference evidence for a later upload', async ({ page }) => {
  const image = await seed(page, { mode: 'automatic', uncertain: true });
  await upload(page, image);
  await expect.poll(async () => {
    const photo = (await stored(page)).find(item => item.fileName === 'new-upload.png');
    return Boolean(photo.autoSuggestions?.faces || photo.autoSuggestions?.metadata);
  }).toBe(false);
  const uploaded = (await stored(page)).find(photo => photo.fileName === 'new-upload.png');
  expect(uploaded.dateOfPhoto).toBe('');
  expect(uploaded.location || '').toBe('');
  expect(uploaded.people).toEqual([]);
  expect(uploaded.faceTags).toEqual([]);
});



test('automatic upload preserves a TIFF comment date as confirmed metadata', async ({ page }) => {
  await seed(page, { mode: 'automatic' });
  UTIF._types.basic.rest[40092] = 1;
  const bytes = Buffer.from(UTIF.encodeImage(new Uint8Array(600 * 400 * 4).fill(255), 600, 400, {
    t40092: Array.from(Buffer.from('jún 1994 rodina\0', 'utf16le')),
  }));
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'dated-scan.tif', mimeType: 'image/tiff', buffer: bytes });
  await expect(page.getByRole('status')).toContainText('Import finished');
  await expect.poll(async () => (await stored(page)).find(photo => photo.fileName === 'dated-scan.jpg')?.location).toBe('Family garden');
  const uploaded = (await stored(page)).find(photo => photo.fileName === 'dated-scan.jpg');
  expect(uploaded.dateOfPhoto).toBe('1994-06');
  expect(uploaded.aiMetadata?.dateOfPhoto).toBeUndefined();
  expect(uploaded.aiMetadata?.location).toEqual({ value: 'Family garden', sourcePhotoIds: ['reference'] });
});

test('ambiguous metadata is skipped and existing manually supplied values and tags are preserved', async ({ page }) => {
  await seed(page, { mode: 'automatic' });
  await expect.poll(async () => (await stored(page)).filter(photo => photo.faceRecognition && photo.similarityIndex).length).toBe(2);
  const result = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const { applyAutomaticPhotoSuggestions } = await import('/utils/automaticPhotoSuggestions.ts');
    const reference = (await storageService.loadPhotos()).find(photo => photo.id === 'reference');
    const other = { ...reference, id: 'conflicting-reference', dateOfPhoto: '1999', location: 'Other garden' };
    const target = { ...reference, id: 'new-target', dateOfPhoto: '', location: '', people: [], faceTags: [],
      autoSuggestions: { faces: true, metadata: true } };
    const ambiguous = applyAutomaticPhotoSuggestions(target, [reference, other], [], { faces: true, metadata: true });
    const manual = { ...target, dateOfPhoto: '1968', location: 'Prague', people: ['Eva'],
      faceTags: [{ id: 'manual-tag', name: 'Eva', x: 20, y: 35 }] };
    const preserved = applyAutomaticPhotoSuggestions(manual, [reference], [], { faces: true, metadata: true });
    const existingName = applyAutomaticPhotoSuggestions({ ...target, people: ['Anna'] }, [reference], [], { faces: true, metadata: false });
    return { ambiguous, preserved, existingName };
  });
  expect(result.ambiguous.dateOfPhoto).toBe('');
  expect(result.ambiguous.location).toBe('');
  expect(result.ambiguous.aiMetadata).toBeUndefined();
  expect(result.preserved).toMatchObject({ dateOfPhoto: '1968', location: 'Prague', people: ['Eva'],
    faceTags: [{ id: 'manual-tag', name: 'Eva', x: 20, y: 35 }] });
  expect(result.preserved.aiMetadata).toBeUndefined();
  expect(result.existingName.people).toEqual(['Anna']);
  expect(result.existingName.faceTags).toHaveLength(1);
  expect(result.existingName.faceTags[0].aiSuggested).toBe(true);
  expect(result.existingName.faceTags[0].aiAddedPerson).toBeFalsy();
});


test('queued editor saves preserve automatic results and failed automatic writes remain retryable', async ({ page }) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const existing = (await storageService.loadPhotos()).find(photo => photo.id === 'existing-blank');
    const baseline = await storageService.savePhoto({ ...existing, autoSuggestions: { faces: true, metadata: true } });
    const transform = photo => ({ ...photo, dateOfPhoto: '1970-06', location: 'Family garden',
      aiMetadata: { dateOfPhoto: { value: '1970-06', sourcePhotoIds: ['reference'] },
        location: { value: 'Family garden', sourcePhotoIds: ['reference'] } },
      autoSuggestions: { faces: false, metadata: false } });
    const adapter = storageService.adapter;
    const save = adapter.savePhoto.bind(adapter);
    adapter.savePhoto = async () => { throw new Error('Test automatic save failure'); };
    let failed = false;
    try { await storageService.saveAutomaticSuggestions(baseline, transform, () => true); }
    catch { failed = true; }
    finally { adapter.savePhoto = save; }
    const afterFailure = (await storageService.loadPhotos()).find(photo => photo.id === baseline.id);
    await storageService.saveAutomaticSuggestions(afterFailure, transform, () => true);
    // This editor payload was prepared before automatic fields committed.
    const final = await storageService.savePhoto({ ...baseline, description: 'Manually typed caption' }, baseline);
    return { failed, afterFailure, final };
  });
  expect(result.failed).toBe(true);
  expect(result.afterFailure.dateOfPhoto).toBe('');
  expect(result.afterFailure.aiMetadata).toBeUndefined();
  expect(result.afterFailure.autoSuggestions).toEqual({ faces: true, metadata: true });
  expect(result.final).toMatchObject({ description: 'Manually typed caption', dateOfPhoto: '1970-06', location: 'Family garden',
    autoSuggestions: { faces: false, metadata: false }, aiMetadata: {
      dateOfPhoto: { value: '1970-06', sourcePhotoIds: ['reference'] },
      location: { value: 'Family garden', sourcePhotoIds: ['reference'] },
    } });
});

for (const held of [false, true]) {
  test(`a later editor save retains an earlier failed edit (${held ? 'failure after second save queued' : 'failure before second edit'})`, async ({ page }) => {
    await seed(page);
    await page.getByRole('img', { name: 'Existing blank photo', exact: true }).click();
    await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
    await page.evaluate(async held => {
      const { storageService } = await import('/services/storageService.ts');
      const adapter = storageService.adapter;
      const saveAdapter = adapter.savePhoto.bind(adapter);
      const saveService = storageService.savePhoto.bind(storageService);
      window.editorSaveCalls = 0;
      window.firstEditorSaveStarted = false;
      let failed = false;
      storageService.savePhoto = (...args) => {
        if (args[0].id === 'existing-blank') window.editorSaveCalls++;
        return saveService(...args);
      };
      adapter.savePhoto = async (photo, ...args) => {
        if (photo.id === 'existing-blank' && !failed) {
          failed = true;
          window.firstEditorSaveStarted = true;
          if (held) await new Promise((resolve, reject) => {
            window.rejectFirstEditorSave = () => reject(new Error('Test first editor save failure'));
          });
          throw new Error('Test first editor save failure');
        }
        return saveAdapter(photo, ...args);
      };
    }, held);
    const details = editor(page);
    await details.getByPlaceholder("Grandma's 60th birthday at the lake house...").fill('Recovered caption');
    await expect.poll(() => page.evaluate(() => window.firstEditorSaveStarted)).toBe(true);
    if (!held) await expect(details.getByRole('alert')).toContainText('Changes could not be saved');
    await details.getByPlaceholder("e.g. Grandma's Garden, Paris").fill('Prague');
    await expect.poll(() => page.evaluate(() => window.editorSaveCalls)).toBe(2);
    if (held) await page.evaluate(() => window.rejectFirstEditorSave());
    await expect.poll(async () => {
      const photo = (await stored(page)).find(item => item.id === 'existing-blank');
      return { description: photo.description, location: photo.location };
    }).toEqual({ description: 'Recovered caption', location: 'Prague' });
    await expect(details.getByRole('alert')).toHaveCount(0);
    await page.reload();
    await page.getByRole('img', { name: 'Recovered caption', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Photo viewer', exact: true })).toContainText('Prague');
  });
}

test('an explicit revert is retained when an earlier successful save is still queued', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const photo = (await storageService.loadPhotos()).find(item => item.id === 'existing-blank');
    await storageService.savePhoto({ ...photo, location: 'Prague' });
  });
  await page.reload();
  await page.getByRole('img', { name: 'Existing blank photo', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const adapter = storageService.adapter;
    const saveAdapter = adapter.savePhoto.bind(adapter);
    const saveService = storageService.savePhoto.bind(storageService);
    window.editorSaveCalls = 0;
    window.firstEditorSaveStarted = false;
    let held = false;
    storageService.savePhoto = (...args) => {
      if (args[0].id === 'existing-blank') window.editorSaveCalls++;
      return saveService(...args);
    };
    adapter.savePhoto = async (photo, ...args) => {
      if (photo.id === 'existing-blank' && !held) {
        held = true;
        window.firstEditorSaveStarted = true;
        await new Promise(resolve => { window.releaseFirstEditorSave = resolve; });
      }
      return saveAdapter(photo, ...args);
    };
  });
  const location = editor(page).getByPlaceholder("e.g. Grandma's Garden, Paris");
  await expect(location).toHaveValue('Prague');
  await location.fill('Vienna');
  await expect.poll(() => page.evaluate(() => window.firstEditorSaveStarted)).toBe(true);
  await location.fill('Prague');
  await expect.poll(() => page.evaluate(() => window.editorSaveCalls)).toBe(2);
  await page.evaluate(() => window.releaseFirstEditorSave());
  await expect.poll(async () => (await stored(page)).find(photo => photo.id === 'existing-blank').location).toBe('Prague');
  await expect(location).toHaveValue('Prague');
  await page.reload();
  await page.getByRole('img', { name: 'Existing blank photo', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  await expect(editor(page).getByPlaceholder("e.g. Grandma's Garden, Paris")).toHaveValue('Prague');
});
