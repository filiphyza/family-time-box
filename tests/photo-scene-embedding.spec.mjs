import { test, expect } from '@playwright/test';

test('real local scene model links matching reference metadata without external inference', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  const external = [];
  page.on('request', request => {
    if (request.url().startsWith('http') && !['localhost', '127.0.0.1'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  const result = await page.evaluate(async () => {
    const { comparePhotoScenes } = await import('/services/sceneEmbedding.ts');
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const context = canvas.getContext('2d');
    context.fillStyle = '#8ab0ce'; context.fillRect(0, 0, 320, 150);
    context.fillStyle = '#5c774c'; context.fillRect(0, 150, 320, 90);
    context.fillStyle = '#dad1ad'; context.fillRect(80, 85, 165, 110);
    context.fillStyle = '#785039'; context.beginPath(); context.moveTo(60, 90); context.lineTo(160, 20); context.lineTo(260, 90); context.fill();
    context.fillStyle = '#3a3a42'; context.fillRect(150, 132, 38, 63); context.fillRect(100, 110, 26, 32); context.fillRect(204, 110, 26, 32);
    const original = canvas.toDataURL();
    context.fillStyle = '#e34f8b'; context.fillRect(0, 0, 320, 240);
    for (let x = 0; x < 320; x += 20) for (let y = 0; y < 240; y += 20) { context.fillStyle = (x + y) % 40 ? '#332351' : '#e6ce36'; context.fillRect(x, y, 10, 10); }
    const unrelated = canvas.toDataURL();
    const base = { fileName: 'private-filename.png', dateOfPhoto: '', location: '', uploadDate: 1, description: 'Private caption', people: [], tags: [], faceTags: [], isRestoring: false };
    const target = { ...base, id: 'target', originalUrl: original };
    const progress = [];
    const matches = await comparePhotoScenes(target, [
      target,
      { ...base, id: 'matching', originalUrl: original, dateOfPhoto: '1968-07', location: 'Senica' },
      { ...base, id: 'unrelated', originalUrl: unrelated, dateOfPhoto: '1994', location: 'Another place' },
      { ...base, id: 'no-metadata', originalUrl: original },
      ...Array.from({ length: 13 }, (_, index) => ({ ...base, id: `extra-${index}`, originalUrl: unrelated, dateOfPhoto: '2000' })),
    ], 'en', { onProgress: (done, total) => progress.push([done, total]) });
    return { matches, progress };
  });
  expect(result.matches.find(match => match.photoId === 'matching')).toMatchObject({ confidence: 'possible', dateEvidence: true, locationEvidence: true, reasons: expect.arrayContaining(['scene']) });
  expect(result.matches.find(match => match.photoId === 'matching').similarity).toBeCloseTo(1, 4);
  expect(result.matches.some(match => ['unrelated', 'target', 'no-metadata'].includes(match.photoId))).toBe(false);
  expect(result.progress[0]).toEqual([0, 15]);
  expect(result.progress.at(-1)).toEqual([15, 15]);
  expect(external).toEqual([]);
});

test('scene evidence rejects uniform images, style-only dates and portable context without similarity', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { sceneDescriptorMatch } = await import('/services/sceneEmbedding.ts');
    const descriptor = { embedding: [1, ...Array(1023).fill(0)], gray: Array(256).fill(0).map((_, index) => index % 2 ? 1 : -1), mean: 128, deviation: 50, saturation: 0.1, aspect: 4 / 3 };
    const photo = { id: 'reference', dateOfPhoto: '1972', location: 'Garden' };
    return {
      exact: sceneDescriptorMatch(descriptor, descriptor, photo),
      uniform: sceneDescriptorMatch({ ...descriptor, deviation: 0 }, { ...descriptor, deviation: 0 }, photo),
      differentScene: sceneDescriptorMatch(descriptor, { ...descriptor, embedding: [0, 1, ...Array(1022).fill(0)] }, photo),
      sameSceneDifferentComposition: sceneDescriptorMatch(descriptor, { ...descriptor, gray: descriptor.gray.map(value => -value) }, photo),
      noMetadata: sceneDescriptorMatch(descriptor, descriptor, { ...photo, dateOfPhoto: '', location: '' }),
    };
  });
  expect(result.exact).toMatchObject({ confidence: 'possible', dateEvidence: true, locationEvidence: true });
  expect(result.uniform).toBeNull(); expect(result.differentScene).toBeNull(); expect(result.noMetadata).toBeNull();
  expect(result.sameSceneDifferentComposition).toBeNull();
});

test('tentative series evidence requires a distinct metadata lead and enough readable references', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { sceneDescriptorMatch } = await import('/services/sceneEmbedding.ts');
    const { buildMetadataSuggestions } = await import('/utils/photoSuggestions.ts');
    const descriptor = { embedding: [1, ...Array(1023).fill(0)], gray: Array(256).fill(0).map((_, index) => index % 2 ? 1 : -1), mean: 128, deviation: 50, saturation: 0.1, aspect: 4 / 3 };
    const related = { ...descriptor, embedding: [0.7, Math.sqrt(1 - 0.7 ** 2), ...Array(1022).fill(0)] };
    const photo = { id: 'reference', dateOfPhoto: '1969-08-31', location: '' };
    const enough = sceneDescriptorMatch(descriptor, related, photo, { referenceCount: 3, dateMargin: 0.2 });
    const suggestions = buildMetadataSuggestions({ id: 'target', dateOfPhoto: '' }, [photo], [enough], 'ai');
    return {
      enough, suggestions,
      noCompetitor: sceneDescriptorMatch(descriptor, related, photo, { referenceCount: 3 }),
      tooFew: sceneDescriptorMatch(descriptor, related, photo, { referenceCount: 2, dateMargin: 0.2 }),
      ambiguous: sceneDescriptorMatch(descriptor, related, photo, { referenceCount: 3, dateMargin: 0.03 }),
      tied: sceneDescriptorMatch(descriptor, related, photo, { referenceCount: 3, dateMargin: 0 }),
    };
  });
  expect(result.enough).toMatchObject({ confidence: 'possible', dateEvidence: true, reasons: expect.arrayContaining(['series']) });
  expect(result.suggestions.dates[0]).toMatchObject({ value: '1969-08-31', confidence: 'possible', sourcePhotoIds: ['reference'] });
  expect(result.noCompetitor).toBeNull(); expect(result.tooFew).toBeNull(); expect(result.ambiguous).toBeNull(); expect(result.tied).toBeNull();
});

test('real scene model handles changed framing and brightness of the same objects', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { comparePhotoScenes } = await import('/services/sceneEmbedding.ts');
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#a6bdd0'; ctx.fillRect(0, 0, 320, 150); ctx.fillStyle = '#586c44'; ctx.fillRect(0, 150, 320, 90);
    ctx.fillStyle = '#d9cdb1'; ctx.fillRect(70, 80, 170, 120); ctx.fillStyle = '#744a38'; ctx.beginPath(); ctx.moveTo(55, 85); ctx.lineTo(155, 20); ctx.lineTo(255, 85); ctx.fill();
    ctx.fillStyle = '#303748'; ctx.fillRect(145, 120, 35, 80); ctx.fillRect(95, 110, 25, 25); ctx.fillRect(200, 110, 25, 25);
    const sameScene = canvas.toDataURL();
    const image = new Image(); image.src = sameScene; await image.decode();
    ctx.drawImage(image, 12, 8, 300, 224, 0, 0, 320, 240); ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(0, 0, 320, 240);
    const targetSource = canvas.toDataURL();
    ctx.fillStyle = '#951d50'; ctx.fillRect(0, 0, 320, 240);
    for (let x = 0; x < 320; x += 20) for (let y = 0; y < 240; y += 20) { ctx.fillStyle = (x + y) % 40 ? '#164725' : '#e8e122'; ctx.fillRect(x, y, 12, 12); }
    const otherOne = canvas.toDataURL();
    ctx.fillStyle = '#151515'; ctx.fillRect(0, 0, 320, 240); ctx.fillStyle = '#fdfdfd'; for (let x = 0; x < 320; x += 25) ctx.fillRect(x, 0, 5, 240);
    const otherTwo = canvas.toDataURL();
    const photo = { id: 'target', originalUrl: targetSource, dateOfPhoto: '' };
    return comparePhotoScenes(photo, [
      { id: 'same-series', originalUrl: sameScene, dateOfPhoto: '1968-07' },
      { id: 'different-one', originalUrl: otherOne, dateOfPhoto: '1984' },
      { id: 'different-two', originalUrl: otherTwo, dateOfPhoto: '1990' },
    ], 'en');
  });
  expect(result.find(match => match.photoId === 'same-series')).toMatchObject({ confidence: 'possible', dateEvidence: true, reasons: expect.arrayContaining(['scene', 'series']) });
  expect(result.some(match => match.photoId.startsWith('different'))).toBe(false);
});

test('local scene comparison stops an in-flight worker on cancellation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { comparePhotoScenes } = await import('/services/sceneEmbedding.ts');
    let terminated = 0, requests = 0;
    const RealWorker = window.Worker;
    const controller = new AbortController();
    window.Worker = class { postMessage() { requests++; setTimeout(() => controller.abort(), 0); } terminate() { terminated++; } };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 20;
    const source = canvas.toDataURL();
    const photo = { id: 'target', originalUrl: source, dateOfPhoto: '', location: '' };
    try {
      await comparePhotoScenes(photo, [{ ...photo, id: 'reference', dateOfPhoto: '1972' }], 'en', { signal: controller.signal });
      return { error: '', terminated, requests };
    } catch (error) { return { error: error.name, terminated, requests }; }
    finally { window.Worker = RealWorker; }
  });
  expect(result).toEqual({ error: 'AbortError', terminated: 1, requests: 1 });
});

test('scene comparison skips missing metadata and honors an already aborted request', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { comparePhotoScenes } = await import('/services/sceneEmbedding.ts');
    const photo = { id: 'target', originalUrl: 'data:invalid', dateOfPhoto: '', location: '' };
    const empty = await comparePhotoScenes(photo, [{ ...photo, id: 'unknown' }], 'en');
    const controller = new AbortController(); controller.abort();
    let aborted = '';
    try { await comparePhotoScenes(photo, [], 'en', { signal: controller.signal }); }
    catch (error) { aborted = error.name; }
    return { empty, aborted };
  });
  expect(result).toEqual({ empty: [], aborted: 'AbortError' });
});
