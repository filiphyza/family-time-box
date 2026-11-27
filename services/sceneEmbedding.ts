import type { Language, Photo, PhotoSimilarityIndex, SceneDescriptor } from '../types';
import { isPartialDate } from '../utils/partialDates';
import type { SimilarPhotoMatch, SimilarityReason } from '../utils/photoSuggestions';
import { runImageInference } from './inferenceScheduler';

export const SCENE_EMBEDDING_MODEL_ID = 'mobilenet-v3-small-2023-float32-bbbb4c51';
export const SCENE_PREPROCESSING_VERSION = 1;
export type { SceneDescriptor } from '../types';

export const validSceneDescriptor = (value: SceneDescriptor | null | undefined): value is SceneDescriptor => Boolean(value && Array.isArray(value.embedding) && value.embedding.length === 1024 &&
  Array.from(value.embedding).every(Number.isFinite) && Array.isArray(value.gray) && value.gray.length === 256 && Array.from(value.gray).every(Number.isFinite) &&
  [value.mean, value.deviation, value.saturation, value.aspect].every(Number.isFinite) && value.aspect > 0 && value.deviation >= 0);
export const similaritySourceRevision = (photo: Photo) => photo.originalRevision || 'legacy-v1';
export const validSimilarityIndex = (photo: Photo): photo is Photo & { similarityIndex: PhotoSimilarityIndex } => {
  const index = photo.similarityIndex;
  return Boolean(index && index.modelId === SCENE_EMBEDDING_MODEL_ID && index.preprocessingVersion === SCENE_PREPROCESSING_VERSION &&
    index.originalRevision === similaritySourceRevision(photo) && validSceneDescriptor(index.descriptor));
};
export const createSimilarityIndex = (photo: Photo, descriptor: SceneDescriptor): PhotoSimilarityIndex => {
  if (!validSceneDescriptor(descriptor)) throw new Error('Invalid photo similarity fingerprint.');
  return { modelId: SCENE_EMBEDDING_MODEL_ID, preprocessingVersion: SCENE_PREPROCESSING_VERSION,
    originalRevision: similaritySourceRevision(photo), descriptor: structuredClone(descriptor) };
};
const cosine = (a: number[], b: number[]) => {
  let dot = 0, lengthA = 0, lengthB = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; lengthA += a[index] ** 2; lengthB += b[index] ** 2; }
  return lengthA && lengthB ? Math.max(-1, Math.min(1, dot / Math.sqrt(lengthA * lengthB))) : 0;
};
// Fingerprints use the original scan consistently. Thumbnail availability or a
// restored preview changing later must not change a persisted fingerprint.
const originalSource = (photo: Photo) => photo.originalUrl;
const descriptorCacheKey = (photo: Photo) => `${similaritySourceRevision(photo)}\0${originalSource(photo)}`;
const descriptorCache = new Map<string, SceneDescriptor>();
let cacheKeyBytes = 0;
const cacheDescriptor = (source: string, descriptor: SceneDescriptor) => {
  if (descriptorCache.has(source)) return;
  descriptorCache.set(source, descriptor); cacheKeyBytes += source.length * 2;
  // The source can itself be a large data URL. Bound both entry count and the
  // retained URL strings, as well as storing vectors rather than image pixels.
  while (descriptorCache.size > 128 || cacheKeyBytes > 16 * 1024 * 1024) {
    const oldest = descriptorCache.keys().next().value as string;
    descriptorCache.delete(oldest); cacheKeyBytes -= oldest.length * 2;
  }
};

/** Generic learned scene similarity; an embedding does not identify an object or place by name. */
export const sceneDescriptorMatch = (
  target: SceneDescriptor, reference: SceneDescriptor, photo: Photo,
  evidence: { dateMargin?: number; locationMargin?: number; referenceCount?: number } = {},
): SimilarPhotoMatch | null => {
  if (!validSceneDescriptor(target) || !validSceneDescriptor(reference) || target.deviation < 8 || reference.deviation < 8) return null;
  const similarity = cosine(target.embedding, reference.embedding);
  const composition = Math.max(0, 1 - Math.sqrt(target.gray.reduce((sum, value, index) => sum + (value - reference.gray[index]) ** 2, 0) / target.gray.length) / 2);
  const format = Math.min(target.aspect, reference.aspect) / Math.max(target.aspect, reference.aspect);
  const appearance = Math.max(0, 1 - Math.abs(target.saturation - reference.saturation) * 2 - Math.abs(target.mean - reference.mean) / 255);
  const closeSeries = similarity >= 0.94 && composition >= 0.78 && appearance >= 0.75 && format >= 0.85;
  // Different frames of an occasion can have a lower absolute MobileNet score.
  // Require a distinctive lead over incompatible metadata, plus photographic
  // appearance, format and some structural overlap. This remains a hypothesis.
  const distinctiveSeries = (evidence.referenceCount ?? 0) >= 3 && similarity >= 0.5 && (evidence.dateMargin ?? 0) >= 0.14 && composition >= 0.25 && appearance >= 0.72 && format >= 0.8;
  const dateEvidence = Boolean(isPartialDate(photo.dateOfPhoto) && !photo.dateOfPhoto.startsWith('--') && (closeSeries || distinctiveSeries));
  const closeSetting = similarity >= 0.88 && composition >= 0.45;
  const distinctiveSetting = (evidence.referenceCount ?? 0) >= 3 && similarity >= 0.6 && (evidence.locationMargin ?? 0) >= 0.12 && composition >= 0.45 && appearance >= 0.65 && format >= 0.65;
  const locationEvidence = Boolean(photo.location?.trim() && (closeSetting || distinctiveSetting));
  if (!dateEvidence && !locationEvidence) return null;
  const reasons: SimilarityReason[] = ['scene'];
  if (dateEvidence) reasons.push('series');
  if (composition >= 0.78) reasons.push('composition');
  if (appearance >= 0.75) reasons.push('appearance');
  if (format >= 0.85) reasons.push('format');
  return { photoId: photo.id, similarity, reasons, confidence: 'possible', dateEvidence, locationEvidence };
};

export const createSceneEmbedder = () => {
  let worker: Worker | undefined;
  const dispose = () => { worker?.terminate(); worker = undefined; };
  return {
    dispose,
    describe(photo: Photo, signal?: AbortSignal, priority = 0): Promise<SceneDescriptor> {
      return runImageInference(async () => {
        signal?.throwIfAborted();
        // Another background/manual request may have completed while this job
        // waited for the shared inference slot. Recheck before reading pixels.
        const key = descriptorCacheKey(photo);
        const cached = descriptorCache.get(key);
        if (cached) return cached;
        const response = await fetch(originalSource(photo), { signal });
        if (!response.ok) throw new Error('Could not read the original photograph.');
        let image = await createImageBitmap(await response.blob());
        let transferred = false;
        try {
          signal?.throwIfAborted();
          if (Math.max(image.width, image.height) > 640) {
            const scale = 640 / Math.max(image.width, image.height);
            const resized = await createImageBitmap(image, { resizeWidth: Math.max(1, Math.round(image.width * scale)), resizeHeight: Math.max(1, Math.round(image.height * scale)), resizeQuality: 'high' });
            image.close(); image = resized;
          }
          signal?.throwIfAborted();
          worker ||= new Worker(new URL('../workers/sceneEmbedding.worker.ts', import.meta.url), { type: 'module' });
          const descriptor = await new Promise<SceneDescriptor>((resolve, reject) => {
            let settled = false;
            const finish = (error?: unknown, result?: SceneDescriptor) => {
              if (settled) return;
              settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
              if (error) reject(error); else resolve(result!);
            };
            const abort = () => { finish(new DOMException('Scene comparison cancelled', 'AbortError')); dispose(); };
            const timeout = setTimeout(() => { finish(new Error('Scene comparison timed out.')); dispose(); }, 60000);
            signal?.addEventListener('abort', abort, { once: true });
            worker!.onmessage = event => {
              if (event.data.type === 'result') {
                if (!validSceneDescriptor(event.data.descriptor)) finish(new Error('Invalid local scene comparison result.'));
                else finish(undefined, event.data.descriptor);
              } else if (event.data.type === 'error') finish(new Error('Local scene model could not finish. Check the model files and retry.'));
            };
            worker!.onerror = event => { finish(new Error(event.message || 'Local scene comparison failed.')); dispose(); };
            worker!.onmessageerror = () => { finish(new Error('Could not read local scene comparison results.')); dispose(); };
            const assetBase = new URL(`${import.meta.env.BASE_URL}scene-embedding/`, window.location.origin).href;
            const wasmBase = new URL(`${import.meta.env.BASE_URL}face-detection/wasm`, window.location.origin).href;
            try { worker!.postMessage({ image, assetBase, wasmBase }, [image]); transferred = true; }
            catch (error) { finish(error); dispose(); }
            if (signal?.aborted) abort();
          });
          signal?.throwIfAborted();
          cacheDescriptor(key, descriptor);
          return descriptor;
        } finally { if (!transferred) image.close(); }
      }, { signal, priority });
    },
  };
};

const eligibleReferences = (target: Photo, references: Photo[]) => {
  const seen = new Set<string>();
  return references.filter(photo => {
    if (photo.id === target.id || seen.has(photo.id) || !photo.originalUrl ||
      (!(isPartialDate(photo.dateOfPhoto) && !photo.dateOfPhoto.startsWith('--')) && !photo.location?.trim())) return false;
    seen.add(photo.id); return true;
  });
};

const rankSceneReferences = (descriptor: SceneDescriptor, described: Array<{ photo: Photo; descriptor: SceneDescriptor }>): SimilarPhotoMatch[] => {
  if (descriptor.deviation < 8) return [];
  const references = described.filter(item => item.descriptor.deviation >= 8)
    .map(item => ({ ...item, similarity: cosine(descriptor.embedding, item.descriptor.embedding) }));
  const dateScores = new Map<string, number>(), locationScores = new Map<string, number>();
  const cleanLocation = (value?: string) => value?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase() || '';
  for (const { photo, similarity } of references) {
    if (isPartialDate(photo.dateOfPhoto) && !photo.dateOfPhoto.startsWith('--')) dateScores.set(photo.dateOfPhoto, Math.max(dateScores.get(photo.dateOfPhoto) ?? -1, similarity));
    const location = cleanLocation(photo.location);
    if (location) locationScores.set(location, Math.max(locationScores.get(location) ?? -1, similarity));
  }
  const rankedDates = [...dateScores].sort((a, b) => b[1] - a[1]);
  const rankedLocations = [...locationScores].sort((a, b) => b[1] - a[1]);
  const compatibleDates = (a: string, b: string) => a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
  return references.flatMap(reference => {
    const competitorDate = rankedDates.find(([value]) => !compatibleDates(value, reference.photo.dateOfPhoto))?.[1];
    const competitorLocation = rankedLocations.find(([value]) => value !== cleanLocation(reference.photo.location))?.[1];
    const match = sceneDescriptorMatch(descriptor, reference.descriptor, reference.photo, {
      dateMargin: competitorDate === undefined ? undefined : reference.similarity - competitorDate,
      locationMargin: competitorLocation === undefined ? undefined : reference.similarity - competitorLocation,
      referenceCount: described.length,
    });
    return match ? [match] : [];
  }).sort((a, b) => b.similarity - a.similarity);
};

/** Rank saved fingerprints only; never reads images or starts a worker. */
export const matchIndexedPhotoScenes = (target: Photo, references: Photo[]): SimilarPhotoMatch[] | null => {
  if (!validSimilarityIndex(target)) return null;
  const indexed = eligibleReferences(target, references).filter(validSimilarityIndex);
  return rankSceneReferences(target.similarityIndex.descriptor, indexed.map(photo => ({ photo, descriptor: photo.similarityIndex.descriptor })));
};

/** Reuses saved fingerprints and computes missing ones locally when requested. */
export const comparePhotoScenes = async (
  target: Photo, references: Photo[], _language: Language,
  options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void } = {},
): Promise<SimilarPhotoMatch[]> => {
  const { signal } = options;
  signal?.throwIfAborted();
  const candidates = eligibleReferences(target, references);
  if (!candidates.length) return [];
  const session = createSceneEmbedder();
  const describe = async (photo: Photo) => {
    signal?.throwIfAborted();
    if (validSimilarityIndex(photo)) return photo.similarityIndex.descriptor;
    const descriptor = await session.describe(photo, signal, 10);
    signal?.throwIfAborted();
    return descriptor;
  };
  try {
    const descriptor = await describe(target);
    options.onProgress?.(0, candidates.length);
    if (descriptor.deviation < 8) { options.onProgress?.(candidates.length, candidates.length); return []; }
    const described: Array<{ photo: Photo; descriptor: SceneDescriptor }> = [];
    for (const [index, photo] of candidates.entries()) {
      signal?.throwIfAborted();
      try { described.push({ photo, descriptor: await describe(photo) }); }
      catch (error) { if (signal?.aborted) throw error; }
      options.onProgress?.(index + 1, candidates.length);
      if (index % 8 === 7) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (!described.length) throw new Error('Could not read any reference photos for local scene comparison.');
    signal?.throwIfAborted();
    return rankSceneReferences(descriptor, described);
  } finally { session.dispose(); }
};
