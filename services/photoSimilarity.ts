import type { Photo } from '../types';
import { isPartialDate } from '../utils/partialDates';
import type { SimilarPhotoMatch, SimilarityReason } from '../utils/photoSuggestions';

interface Descriptor {
  luma: number[];
  edges: number[];
  histogram: number[];
  average: number;
  deviation: number;
  detail: number;
  entropy: number;
  aspect: number;
}
export interface SimilarPhotoResult { matches: SimilarPhotoMatch[]; rankedPhotoIds: string[]; compared: number; skipped: number }
export interface SimilarPhotoOptions { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void }
const descriptorCache = new Map<string, Descriptor>();
const CACHE_LIMIT = 64;
const CACHE_KEY_BYTE_LIMIT = 16 * 1024 * 1024;
let cacheKeyBytes = 0;
const cacheDescriptor = (source: string, descriptor: Descriptor) => {
  // Source strings can be full base64 scans. Bound their retained bytes as well
  // as the number of small descriptors, including when concurrent reads finish.
  if (!descriptorCache.has(source)) cacheKeyBytes += source.length * 2;
  else descriptorCache.delete(source);
  descriptorCache.set(source, descriptor);
  while (descriptorCache.size > CACHE_LIMIT || cacheKeyBytes > CACHE_KEY_BYTE_LIMIT) {
    const oldest = descriptorCache.keys().next().value!;
    descriptorCache.delete(oldest); cacheKeyBytes -= oldest.length * 2;
  }
};
const GRID = 16;
const SAMPLE = 48;
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Photo comparison cancelled', 'AbortError'); };
const originalSource = (photo: Photo) => photo.thumbnailSource === 'original' && photo.thumbnailUrl ? photo.thumbnailUrl : photo.originalUrl;
const hasMetadata = (photo: Photo) => isPartialDate(photo.dateOfPhoto) && !photo.dateOfPhoto.startsWith('--') || Boolean(photo.location?.trim());

async function describe(source: string, signal?: AbortSignal): Promise<Descriptor> {
  checkAbort(signal);
  const cached = descriptorCache.get(source);
  if (cached) { cacheDescriptor(source, cached); return cached; }
  const image = new Image();
  image.crossOrigin = 'anonymous';
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SAMPLE;
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); image.onload = image.onerror = null; };
      const abort = () => { cleanup(); image.src = ''; reject(new DOMException('Photo comparison cancelled', 'AbortError')); };
      const timeout = setTimeout(() => { cleanup(); image.src = ''; reject(new Error('Could not read a photo for comparison.')); }, 15000);
      image.onload = () => { cleanup(); resolve(); };
      image.onerror = () => { cleanup(); reject(new Error('Could not read a photo for comparison.')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else image.src = source;
    });
    checkAbort(signal);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !image.naturalWidth || !image.naturalHeight) throw new Error('Photo comparison is unavailable.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, SAMPLE, SAMPLE);
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    const pixels = context.getImageData(0, 0, SAMPLE, SAMPLE).data;
    const fullLuma: number[] = [], luma = Array(GRID * GRID).fill(0), edges = Array(GRID * GRID).fill(0), histogram = Array(64).fill(0), light = Array(16).fill(0);
    for (let y = 0; y < SAMPLE; y++) for (let x = 0; x < SAMPLE; x++) {
      const offset = (y * SAMPLE + x) * 4;
      const r = pixels[offset] / 255, g = pixels[offset + 1] / 255, b = pixels[offset + 2] / 255;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      fullLuma.push(luminance);
      luma[Math.floor(y / 3) * GRID + Math.floor(x / 3)] += luminance / 9;
      histogram[Math.min(3, Math.floor(r * 4)) * 16 + Math.min(3, Math.floor(g * 4)) * 4 + Math.min(3, Math.floor(b * 4))]++;
      light[Math.min(15, Math.floor(luminance * 16))]++;
    }
    let detail = 0;
    for (let y = 1; y < SAMPLE - 1; y++) for (let x = 1; x < SAMPLE - 1; x++) {
      const index = y * SAMPLE + x, center = fullLuma[index];
      const gradient = (Math.abs(center - fullLuma[index + 1]) + Math.abs(center - fullLuma[index + SAMPLE])) / 2;
      edges[Math.floor(y / 3) * GRID + Math.floor(x / 3)] += gradient / 9;
      detail += Math.abs(center * 4 - fullLuma[index - 1] - fullLuma[index + 1] - fullLuma[index - SAMPLE] - fullLuma[index + SAMPLE]) / 4;
    }
    const average = luma.reduce((sum, value) => sum + value, 0) / luma.length;
    const deviation = Math.sqrt(luma.reduce((sum, value) => sum + (value - average) ** 2, 0) / luma.length);
    const entropy = light.reduce((sum, count) => { const p = count / (SAMPLE * SAMPLE); return p ? sum - p * Math.log2(p) : sum; }, 0) / 4;
    const descriptor = { luma, edges, histogram: histogram.map(value => value / (SAMPLE * SAMPLE)), average, deviation,
      detail: detail / ((SAMPLE - 2) ** 2), entropy, aspect: image.naturalWidth / image.naturalHeight };
    checkAbort(signal);
    cacheDescriptor(source, descriptor);
    return descriptor;
  } finally { canvas.width = canvas.height = 0; image.onload = image.onerror = null; image.src = ''; }
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, sumA = 0, sumB = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; sumA += a[index] ** 2; sumB += b[index] ** 2; }
  return sumA > 1e-10 && sumB > 1e-10 ? Math.max(0, Math.min(1, dot / Math.sqrt(sumA * sumB))) : 0;
};
const structure = (a: number[], b: number[]) => {
  let best = 0;
  // A small framing shift is common between neighboring negatives or scans.
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const left: number[] = [], right: number[] = [];
    for (let y = 2; y < GRID - 2; y++) for (let x = 2; x < GRID - 2; x++) {
      left.push(a[y * GRID + x]); right.push(b[(y + dy) * GRID + x + dx]);
    }
    const avgA = left.reduce((sum, value) => sum + value, 0) / left.length, avgB = right.reduce((sum, value) => sum + value, 0) / right.length;
    best = Math.max(best, cosine(left.map(value => value - avgA), right.map(value => value - avgB)));
  }
  return best;
};
const nearbyScan = (a: string, b: string) => {
  const first = /^(.*?)(\d+)\.[^.]+$/.exec(a.toLowerCase()), second = /^(.*?)(\d+)\.[^.]+$/.exec(b.toLowerCase());
  return Boolean(first && second && first[1] === second[1] && Math.abs(Number(first[2]) - Number(second[2])) <= 3 && Number(first[2]) !== Number(second[2]));
};

export async function findSimilarPhotos(target: Photo, references: Photo[], { signal, onProgress }: SimilarPhotoOptions = {}): Promise<SimilarPhotoResult> {
  checkAbort(signal);
  const eligible = [...new Map(references.filter(photo => photo.id !== target.id && hasMetadata(photo)).map(photo => [photo.id, photo])).values()];
  const ranked: Array<{ match: SimilarPhotoMatch; accepted: boolean }> = [];
  let skipped = 0, compared = 0;
  onProgress?.(0, eligible.length);
  if (!eligible.length) return { matches: [], rankedPhotoIds: [], compared, skipped };
  const descriptor = await describe(originalSource(target), signal);
  for (const [index, reference] of eligible.entries()) {
    checkAbort(signal);
    try {
      const other = await describe(originalSource(reference), signal);
      const composition = structure(descriptor.luma, other.luma), edge = cosine(descriptor.edges, other.edges);
      const appearance = descriptor.histogram.reduce((sum, value, bin) => sum + Math.min(value, other.histogram[bin]), 0);
      const format = Math.exp(-Math.abs(Math.log(descriptor.aspect / other.aspect)) * 3);
      const tone = Math.max(0, 1 - Math.abs(descriptor.average - other.average) - Math.abs(descriptor.deviation - other.deviation));
      const series = nearbyScan(target.fileName, reference.fileName) && composition > 0.65;
      const similarity = Math.min(1, composition * 0.68 + edge * 0.13 + appearance * 0.11 + format * 0.05 + tone * 0.03 + (series ? 0.01 : 0));
      const distinctive = descriptor.deviation > 0.025 && other.deviation > 0.025 && descriptor.detail > 0.006 && other.detail > 0.006 && descriptor.entropy > 0.20 && other.entropy > 0.20;
      const accepted = distinctive && composition >= 0.87 && edge >= 0.72 && appearance >= 0.45 && format >= 0.55 && similarity >= 0.84;
      const reasons: SimilarityReason[] = [];
      if (composition >= 0.87) reasons.push('composition');
      if (appearance >= 0.80 && tone >= 0.85) reasons.push('appearance');
      if (format >= 0.95) reasons.push('format');
      if (series) reasons.push('series');
      ranked.push({ accepted, match: { photoId: reference.id, similarity, reasons, confidence: 'possible', dateEvidence: true, locationEvidence: true } });
      compared++;
    } catch (error) { if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw error; skipped++; }
    onProgress?.(index + 1, eligible.length);
    if (index % 8 === 7) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  checkAbort(signal);
  ranked.sort((a, b) => b.match.similarity - a.match.similarity || a.match.photoId.localeCompare(b.match.photoId));
  return { matches: ranked.filter(item => item.accepted).slice(0, 12).map(item => item.match), rankedPhotoIds: ranked.map(item => item.match.photoId), compared, skipped };
}
