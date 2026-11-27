import { test, expect } from '@playwright/test';
import UTIF from 'utif2';
import { deflateSync } from 'node:zlib';

function fixture(orientation = 1) {
  const width = 48, height = 32;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    // Four distinct quadrants and a transparent margin exercise orientation and JPEG matting.
    rgba.set(y < 16 ? (x < 24 ? [255,0,0,255] : [0,255,0,255]) : (x < 24 ? [0,0,255,255] : [255,255,0,255]), offset);
    if (x < 3) rgba[offset + 3] = 0;
  }
  return Buffer.from(UTIF.encodeImage(rgba, width, height, { t274: [orientation] }));
}

async function prepare(page, bytes, name, type = '') {
  return page.evaluate(async ({ bytes, name, type }) => {
    const { prepareImageUpload } = await import('/utils/imageUpload.ts');
    const result = await prepareImageUpload(new File([new Uint8Array(bytes)], name, { type }));
    const image = new Image(); image.src = result.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const color = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
    return { ...result, width: image.width, height: image.height, whiteMargin: color(0, 0), topLeft: color(8, 8), topRight: color(image.width - 8, 8) };
  }, { bytes: Array.from(bytes), name, type });
}

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('TIFF signature detection creates full-size JPEG and white transparent margins', async ({ page }) => {
  const result = await prepare(page, fixture(), 'Family.Scan.TIFF');
  expect(result.fileName).toBe('Family.Scan.jpg');
  expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect([result.width, result.height]).toEqual([48, 32]);
  expect(result.topLeft[0]).toBeGreaterThan(220);
  expect(result.topLeft[1]).toBeLessThan(30);
  expect(result.whiteMargin.slice(0, 3).every(value => value > 230)).toBe(true);
  const signatureOnly = await prepare(page, fixture(), 'scan', 'application/octet-stream');
  expect(signatureOnly.fileName).toBe('scan.jpg');
});

test('TIFF orientation is applied to pixels and output dimensions', async ({ page }) => {
  const result = await prepare(page, fixture(6), 'rotated.tif', 'image/tiff');
  expect([result.width, result.height]).toEqual([32, 48]);
  expect(result.topLeft[2]).toBeGreaterThan(220); // bottom-left blue rotates to top-left
  expect(result.topRight[0]).toBeGreaterThan(220); // top-left red rotates to top-right
});

test('ordinary PNG remains unchanged', async ({ page }) => {
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; return canvas.toDataURL('image/png'); });
  const bytes = Buffer.from(png.split(',')[1], 'base64');
  const result = await prepare(page, bytes, 'original.png', 'image/png');
  expect(result.dataUrl).toBe(png);
  expect(result.fileName).toBe('original.png');
});

test('mixed upload imports valid TIFF, reports corrupt file, and recovers loading state', async ({ page }) => {
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  const input = page.locator('input[type=file]');
  await expect(input).toHaveAttribute('accept', /\.tif/);
  await input.setInputFiles([
    { name: 'broken.tif', mimeType: 'image/tiff', buffer: Buffer.from('invalid TIFF') },
    { name: 'scan.TIF', mimeType: '', buffer: fixture() },
  ]);
  await expect(page.getByRole('alert')).toContainText('broken.tif');
  await expect(page.locator('img[alt="Family Photo"]')).toBeVisible();
  const photos = await page.evaluate(async () => (await import('/services/storageService.ts')).storageService.loadPhotos());
  expect(photos).toHaveLength(1);
  expect(photos[0].fileName).toBe('scan.jpg');
  expect(photos[0].originalUrl).toMatch(/^data:image\/jpeg;base64,/);
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await expect(page.locator('input[type=file]')).toBeEnabled();
});

test('local folder storage writes converted JPEG bytes with a jpg path', async ({ page }) => {
  const bytes = Array.from(fixture());
  const result = await page.evaluate(async bytes => {
    const saved = new Map();
    const makeFile = name => ({
      getFile: async () => new File(saved.has(name) ? [saved.get(name)] : [], name),
      createWritable: async () => ({ write: async data => saved.set(name, data), close: async () => {} }),
    });
    window.showDirectoryPicker = async () => ({
      getDirectoryHandle: async () => ({ getFileHandle: async name => makeFile(`images/${name}`) }),
      getFileHandle: async name => makeFile(name),
    });
    const { storageService } = await import('/services/storageService.ts');
    const { prepareImageUpload } = await import('/utils/imageUpload.ts');
    const converted = await prepareImageUpload(new File([new Uint8Array(bytes)], 'scan.tiff'));
    storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
    await storageService.connectFileSystem();
    await storageService.savePhoto({ id: 'tiff-test', originalUrl: converted.dataUrl, fileName: converted.fileName, uploadDate: 1, description: '', people: [], tags: [], faceTags: [], dateOfPhoto: '', isRestoring: false });
    const image = saved.get('images/tiff-test_original.jpg');
    return { db: JSON.parse(saved.get('ancestry_db.json')), mimeType: image.type, signature: Array.from(new Uint8Array(await image.arrayBuffer()).slice(0, 2)) };
  }, bytes);
  expect(result.db[0].originalUrl).toBe('images/tiff-test_original.jpg');
  expect(result.mimeType).toBe('image/jpeg');
  expect(result.signature).toEqual([255, 216]);
});

test('16-bit deflate-compressed grayscale scans convert to JPEG', async ({ page }) => {
  const width = 48, height = 32;
  const pixels = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.writeUInt16BE(x < 24 ? 0 : 65535, (y * width + x) * 2);
  }
  const compressed = deflateSync(pixels);
  const header = Buffer.from(UTIF.encode([{
    t256: [width], t257: [height], t258: [16], t259: [8], t262: [1],
    t273: [1000], t277: [1], t278: [height], t279: [compressed.length], t284: [1],
  }]));
  const bytes = Buffer.alloc(1000 + compressed.length);
  header.copy(bytes); compressed.copy(bytes, 1000);
  const result = await prepare(page, bytes, 'gray16.tiff', 'image/tiff');
  expect([result.width, result.height]).toEqual([width, height]);
  expect(result.topLeft.slice(0, 3).every(value => value < 20)).toBe(true);
  expect(result.topRight.slice(0, 3).every(value => value > 235)).toBe(true);
});

test('multi-page TIFF imports its first page', async ({ page }) => {
  const first = fixture();
  const firstIFD = UTIF.decode(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength))[0];
  const pixelLength = 48 * 32 * 4;
  const secondIFD = { ...firstIFD, t273: [1000 + pixelLength] };
  const header = Buffer.from(UTIF.encode([firstIFD, secondIFD]));
  const bytes = Buffer.alloc(1000 + pixelLength * 2);
  header.copy(bytes); first.copy(bytes, 1000, 1000);
  for (let offset = 1000 + pixelLength; offset < bytes.length; offset += 4) {
    bytes.set([0, 255, 0, 255], offset);
  }
  const result = await prepare(page, bytes, 'two-pages.tif');
  expect(result.fileName).toBe('two-pages.jpg');
  expect([result.width, result.height]).toEqual([48, 32]);
  expect(result.topLeft[0]).toBeGreaterThan(220);
  expect(result.topLeft[1]).toBeLessThan(30);
});
