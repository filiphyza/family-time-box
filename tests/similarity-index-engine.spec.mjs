import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ancestry-lens-similarity-paused', 'true'));
});

test('saved fingerprints survive session URLs and reject stale versions, revisions and malformed vectors', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createSimilarityIndex, validSimilarityIndex } = await import('/services/sceneEmbedding.ts');
    const descriptor = { embedding: [1, ...Array(1023).fill(0)], gray: Array(256).fill(1), mean: 128, deviation: 50, saturation: 0.1, aspect: 1.5 };
    const photo = { id: 'legacy', originalUrl: 'blob:first-session' };
    const index = createSimilarityIndex(photo, descriptor);
    const saved = { ...photo, similarityIndex: index };
    const malformed = structuredClone(index); malformed.descriptor.embedding[5] = NaN;
    const sparse = structuredClone(index); delete sparse.descriptor.gray[10];
    descriptor.embedding[0] = 0;
    return {
      legacyRevision: index.originalRevision,
      cloned: index.descriptor.embedding[0],
      same: validSimilarityIndex(saved),
      newSession: validSimilarityIndex({ ...saved, originalUrl: 'blob:second-session', thumbnailUrl: 'new-preview' }),
      replaced: validSimilarityIndex({ ...saved, originalRevision: 'replacement' }),
      model: validSimilarityIndex({ ...saved, similarityIndex: { ...index, modelId: 'old-model' } }),
      preprocessing: validSimilarityIndex({ ...saved, similarityIndex: { ...index, preprocessingVersion: -1 } }),
      malformed: validSimilarityIndex({ ...saved, similarityIndex: malformed }),
      sparse: validSimilarityIndex({ ...saved, similarityIndex: sparse }),
    };
  });
  expect(result).toEqual({ legacyRevision: 'legacy-v1', cloned: 1, same: true, newSession: true,
    replaced: false, model: false, preprocessing: false, malformed: false, sparse: false });
});

test('indexed matching uses available references and current metadata without image inference', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createSimilarityIndex, matchIndexedPhotoScenes } = await import('/services/sceneEmbedding.ts');
    const { buildMetadataSuggestions } = await import('/utils/photoSuggestions.ts');
    const descriptor = { embedding: [1, ...Array(1023).fill(0)], gray: Array.from({ length: 256 }, (_, i) => i % 2 ? 1 : -1), mean: 128, deviation: 50, saturation: 0.1, aspect: 1.5 };
    const target = { id: 'target', originalUrl: 'blob:unreadable-target', originalRevision: 'r1', dateOfPhoto: '', location: '' };
    target.similarityIndex = createSimilarityIndex(target, descriptor);
    const reference = { ...target, id: 'reference', originalUrl: 'blob:unreadable-reference', dateOfPhoto: '1968', location: 'Senica' };
    reference.similarityIndex = createSimilarityIndex(reference, descriptor);
    const pending = { ...reference, id: 'pending', similarityIndex: undefined };
    const noMetadata = { ...reference, id: 'undated', dateOfPhoto: '', location: '' };
    const NativeWorker = window.Worker;
    let workers = 0;
    window.Worker = class { constructor() { workers++; throw new Error('Unexpected inference'); } };
    try {
      const matches = matchIndexedPhotoScenes(target, [target, reference, reference, pending, noMetadata]);
      const changed = { ...reference, dateOfPhoto: '1972', location: 'Garden' };
      const changedMatches = matchIndexedPhotoScenes(target, [changed]);
      return {
        matches, workers,
        dates: buildMetadataSuggestions(target, [changed], changedMatches, 'ai').dates.map(item => item.value),
        missingTarget: matchIndexedPhotoScenes({ ...target, originalRevision: 'r2' }, [reference]),
      };
    } finally { window.Worker = NativeWorker; }
  });
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]).toMatchObject({ photoId: 'reference', confidence: 'possible', dateEvidence: true, locationEvidence: true });
  expect(result.workers).toBe(0);
  expect(result.dates).toEqual(['1972']);
  expect(result.missingTarget).toBeNull();
});

test('reloaded saved fingerprints satisfy scene comparisons without reading old image URLs', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { createSimilarityIndex } = await import('/services/sceneEmbedding.ts');
    const descriptor = { embedding: [1, ...Array(1023).fill(0)], gray: Array.from({ length: 256 }, (_, i) => i % 2 ? 1 : -1), mean: 128, deviation: 50, saturation: 0.1, aspect: 1.5 };
    const photos = [{ id: 'target', originalUrl: 'blob:expired-target', dateOfPhoto: '' },
      { id: 'reference', originalUrl: 'blob:expired-reference', dateOfPhoto: '1968-07', location: 'Senica' }];
    for (const photo of photos) photo.similarityIndex = createSimilarityIndex(photo, descriptor);
    localStorage.setItem('similarity-engine-fixtures', JSON.stringify(photos));
  });
  await page.reload();
  const result = await page.evaluate(async () => {
    const { comparePhotoScenes } = await import('/services/sceneEmbedding.ts');
    const [target, reference] = JSON.parse(localStorage.getItem('similarity-engine-fixtures'));
    const NativeWorker = window.Worker, nativeFetch = window.fetch;
    let workers = 0, imageReads = 0;
    window.Worker = class { constructor() { workers++; throw new Error('Unexpected inference'); } };
    window.fetch = (...args) => { imageReads++; throw new Error('Unexpected image read'); };
    try {
      const progress = [];
      return { matches: await comparePhotoScenes(target, [reference], 'en', { onProgress: (done, total) => progress.push([done, total]) }), progress, workers, imageReads };
    } finally { window.Worker = NativeWorker; window.fetch = nativeFetch; }
  });
  expect(result.matches[0]).toMatchObject({ photoId: 'reference', dateEvidence: true, locationEvidence: true });
  expect(result.progress).toEqual([[0, 1], [1, 1]]);
  expect(result.workers).toBe(0);
  expect(result.imageReads).toBe(0);
});

test('shared inference queue honors priority, cancels queued jobs and retains an aborted active slot until settled', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { runImageInference } = await import('/services/inferenceScheduler.ts');
    const events = [];
    const activeController = new AbortController(), queuedController = new AbortController();
    let release;
    const active = runImageInference(async () => {
      events.push('active'); await new Promise(resolve => { release = resolve; }); events.push('active-finished');
    }, { signal: activeController.signal }).catch(error => error.name);
    await new Promise(resolve => setTimeout(resolve, 0));
    const low = runImageInference(async () => { events.push('low'); }, { priority: 0 });
    const high = runImageInference(async () => { events.push('high'); }, { priority: 10 });
    const cancelled = runImageInference(async () => { events.push('cancelled'); }, { signal: queuedController.signal, priority: 20 }).catch(error => error.name);
    queuedController.abort(); activeController.abort();
    const errors = await Promise.all([active, cancelled]);
    const beforeRelease = [...events];
    release();
    await Promise.all([low, high]);
    const failure = runImageInference(async () => { throw new Error('Expected failure'); }).catch(error => error.message);
    const recovery = runImageInference(async () => 'recovered');
    return { errors, beforeRelease, events, failure: await failure, recovery: await recovery };
  });
  expect(result.errors).toEqual(['AbortError', 'AbortError']);
  expect(result.beforeRelease).toEqual(['active']);
  expect(result.events).toEqual(['active', 'active-finished', 'high', 'low']);
  expect(result.failure).toBe('Expected failure');
  expect(result.recovery).toBe('recovered');
});

test('scene indexing consistently resizes originals and reuses one worker across a batch', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createSceneEmbedder } = await import('/services/sceneEmbedding.ts');
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 500;
    canvas.getContext('2d').fillRect(0, 0, 1000, 500);
    const originalUrl = canvas.toDataURL();
    const NativeWorker = window.Worker;
    let workers = 0, terminations = 0;
    const sizes = [];
    window.Worker = class {
      constructor() { workers++; }
      postMessage({ image }) {
        sizes.push([image.width, image.height]); image.close();
        setTimeout(() => this.onmessage?.({ data: { type: 'result', descriptor: {
          embedding: [1, ...Array(1023).fill(0)], gray: Array(256).fill(0), mean: 128, deviation: 50, saturation: 0.1, aspect: 2,
        } } }), 0);
      }
      terminate() { terminations++; }
    };
    const session = createSceneEmbedder();
    try {
      await session.describe({ id: 'one', originalUrl, thumbnailUrl: 'blob:unavailable-thumbnail', thumbnailSource: 'original' });
      await session.describe({ id: 'two', originalUrl, originalRevision: 'another-original', thumbnailUrl: 'blob:different-thumbnail', thumbnailSource: 'restored' });
      session.dispose();
      return { workers, sizes, terminations };
    } finally { session.dispose(); window.Worker = NativeWorker; }
  });
  expect(result.workers).toBe(1);
  expect(result.sizes).toEqual([[640, 320], [640, 320]]);
  expect(result.terminations).toBe(1);
});

test('queued manual and background sessions share one computed fingerprint and later indexing reuses it', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createSceneEmbedder } = await import('/services/sceneEmbedding.ts');
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 30;
    const photo = { id: 'shared', originalUrl: canvas.toDataURL(), originalRevision: 'original-1' };
    const NativeWorker = window.Worker;
    let workers = 0, inferences = 0;
    window.Worker = class {
      constructor() { workers++; }
      postMessage({ image }) {
        image.close(); inferences++;
        setTimeout(() => this.onmessage?.({ data: { type: 'result', descriptor: {
          embedding: [1, ...Array(1023).fill(0)], gray: Array(256).fill(0), mean: 128, deviation: 50, saturation: 0.1, aspect: 4 / 3,
        } } }), 10);
      }
      terminate() {}
    };
    const background = createSceneEmbedder(), manual = createSceneEmbedder(), later = createSceneEmbedder();
    try {
      const [first, second] = await Promise.all([background.describe(photo), manual.describe(photo, undefined, 10)]);
      const third = await later.describe(photo);
      const beforeReplacement = inferences;
      await later.describe({ ...photo, originalRevision: 'original-2' });
      return { workers, beforeReplacement, inferences, equal: JSON.stringify(first) === JSON.stringify(second) && JSON.stringify(first) === JSON.stringify(third) };
    } finally { background.dispose(); manual.dispose(); later.dispose(); window.Worker = NativeWorker; }
  });
  expect(result).toEqual({ workers: 2, beforeReplacement: 1, inferences: 2, equal: true });
});

test('failed and malformed worker results never enter the shared descriptor cache', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createSceneEmbedder } = await import('/services/sceneEmbedding.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 20;
    const photo = { id: 'retry', originalUrl: canvas.toDataURL() };
    const NativeWorker = window.Worker;
    let attempts = 0;
    window.Worker = class {
      postMessage({ image }) {
        image.close(); const attempt = ++attempts;
        setTimeout(() => this.onmessage?.({ data: attempt === 2 ? { type: 'error' } : { type: 'result', descriptor: {
          embedding: [attempt === 1 ? NaN : 1, ...Array(1023).fill(0)], gray: Array(256).fill(0), mean: 128, deviation: 50, saturation: 0.1, aspect: 1,
        } } }), 0);
      }
      terminate() {}
    };
    const session = createSceneEmbedder();
    try {
      const malformed = await session.describe(photo).then(() => false, () => true);
      const failed = await session.describe(photo).then(() => false, () => true);
      const descriptor = await session.describe(photo);
      await session.describe(photo);
      return { malformed, failed, attempts, validValue: descriptor.embedding[0] };
    } finally { session.dispose(); window.Worker = NativeWorker; }
  });
  expect(result).toEqual({ malformed: true, failed: true, attempts: 3, validValue: 1 });
});
