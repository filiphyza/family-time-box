import { test, expect } from '@playwright/test';

const boxes = [
  { id: 'face-1', x: 15, y: 20, width: 20, height: 30, confidence: 0.95 },
  { id: 'face-2', x: 60, y: 20, width: 20, height: 30, confidence: 0.9 },
];

async function seed(page, tags = []) {
  await page.goto('/');
  await page.evaluate(async tags => {
    const { storageService } = await import('/services/storageService.ts');
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
    for (let index = 1; index <= 2; index++) await storageService.savePhoto({
      id: `detect-${index}`, originalUrl: canvas.toDataURL(), fileName: `detect-${index}.png`, uploadDate: index,
      description: `Detection test ${index}`, people: index === 1 ? ['Anna'] : tags.map(tag => tag.name),
      faceTags: index === 2 ? tags : [], tags: [], dateOfPhoto: '', isRestoring: false,
    });
  }, tags);
  await page.reload();
  await page.getByRole('img', { name: 'Detection test 2', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  return page.getByRole('dialog', { name: 'Photo Details', exact: true });
}

async function fakeDetector(page, mode = 'result') {
  await page.addInitScript(({ boxes, mode }) => {
    const NativeWorker = window.Worker;
    window.detectorStarts = 0; window.detectorStops = 0;
    window.Worker = class {
      constructor(url, options) {
        if (!String(url).includes('faceDetection.worker')) return new NativeWorker(url, options);
        this.stopped = false;
      }
      postMessage(message) {
        window.detectorStarts++;
        message.image.close();
        const result = () => {
          if (this.stopped) return;
          this.onmessage?.({ data: mode === 'error' ? { type: 'error' } : { type: 'result', faces: boxes } });
        };
        if (mode === 'held') window.releaseDetector = result;
        else setTimeout(result, 30);
      }
      terminate() { this.stopped = true; window.detectorStops++; }
    };
  }, { boxes, mode });
}

async function saved(page) {
  return page.evaluate(async () => (await (await import('/services/storageService.ts')).storageService.loadPhotos()).find(photo => photo.id === 'detect-2'));
}

test('arrow detects boxes and only saves names selected by the user', async ({ page }) => {
  await fakeDetector(page);
  const dialog = await seed(page);
  await expect(dialog.getByRole('button', { name: 'Detect faces', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Tag People', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Detected face \d$/ })).toHaveCount(2);
  await expect(dialog.getByRole('status').filter({ hasText: 'Faces to name: 2' })).toContainText('Faces to name: 2');
  expect((await saved(page)).faceTags).toEqual([]);
  expect((await saved(page)).people).toEqual([]);
  await dialog.getByRole('button', { name: 'Detected face 1', exact: true }).click();
  await dialog.getByRole('option', { name: 'Anna', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Detected face \d$/ })).toHaveCount(1);
  expect((await saved(page)).faceTags[0]).toMatchObject({ name: 'Anna', x: 25, y: 35 });
  await dialog.getByRole('button', { name: 'Detected face 1', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Who is this?', exact: true }).fill('Peter');
  await dialog.getByRole('button', { name: 'Tag person', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Tag People', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('status').filter({ hasText: 'All detected faces have names' })).toContainText('All detected faces have names');
  const photo = await saved(page);
  expect(photo.faceTags.map(tag => tag.name)).toEqual(['Anna', 'Peter']);
  expect(photo.faceTags[1]).toMatchObject({ x: 70, y: 35 });
  expect(photo.people).toEqual(['Anna', 'Peter']);
  // Continue manually with a missed face after every detected box has been named.
  await dialog.getByRole('img', { name: 'Main view', exact: true }).click({ position: { x: 300, y: 300 } });
  await dialog.getByRole('combobox', { name: 'Who is this?', exact: true }).fill('Mária');
  await dialog.getByRole('button', { name: 'Tag person', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Tag People', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await saved(page)).faceTags.map(tag => tag.name)).toEqual(['Anna', 'Peter', 'Mária']);
  expect(await page.evaluate(() => window.detectorStarts)).toBe(1);
  await dialog.getByRole('button', { name: 'Tag People', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Tag People', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  expect((await saved(page)).faceTags.map(tag => tag.name)).toEqual(['Anna', 'Peter', 'Mária']);
});

test('existing tags in this image are preserved and incorrect boxes can be dismissed', async ({ page }) => {
  await fakeDetector(page);
  const tag = { id: 'old-tag', name: 'Anna', x: 25, y: 35 };
  const dialog = await seed(page, [tag]);
  await dialog.getByRole('button', { name: 'Tag People', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Detected face \d$/ })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Detected face 1', exact: true }).click();
  await dialog.getByRole('button', { name: 'Dismiss this box', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Detected face \d$/ })).toHaveCount(0);
  expect((await saved(page)).faceTags).toEqual([tag]);
});

test('leaving tagging mode cancels pending detection', async ({ page }) => {
  await fakeDetector(page, 'held');
  const dialog = await seed(page);
  const arrow = dialog.getByRole('button', { name: 'Tag People', exact: true });
  await arrow.click();
  await page.waitForFunction(() => window.detectorStarts === 1);
  await expect(dialog.getByRole('status').filter({ hasText: 'Loading face detection' })).toContainText('Loading face detection');
  await arrow.click();
  await expect.poll(() => page.evaluate(() => window.detectorStops)).toBe(1);
  await page.evaluate(() => window.releaseDetector());
  await expect(dialog.getByRole('button', { name: /^Detected face \d$/ })).toHaveCount(0);
  expect((await saved(page)).faceTags).toEqual([]);
});

test('detector failure still allows manual face tagging', async ({ page }) => {
  await fakeDetector(page, 'error');
  const dialog = await seed(page);
  await dialog.getByRole('button', { name: 'Tag People', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Face detection could not run' })).toContainText('Face detection could not run');
  await dialog.getByRole('img', { name: 'Main view', exact: true }).click({ position: { x: 200, y: 150 } });
  await dialog.getByRole('option', { name: 'Anna', exact: true }).click();
  expect((await saved(page)).faceTags[0].name).toBe('Anna');
});

test('real local model runs in a worker without an API request', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  const requests = [];
  page.on('request', request => {
    if (request.url().startsWith('http') && !['localhost', '127.0.0.1'].includes(new URL(request.url()).hostname)) requests.push({ method: request.method(), url: request.url() });
  });
  const faces = await page.evaluate(async () => {
    const { detectFaces } = await import('/services/faceDetection.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    return detectFaces(canvas.toDataURL(), { signal: new AbortController().signal });
  });
  expect(faces).toEqual([]);
  expect(requests.filter(request => request.method !== 'GET' || /generativelanguage|face-detection|mediapipe/.test(request.url))).toEqual([]);
});

