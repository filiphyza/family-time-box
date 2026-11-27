import type { FaceTag } from '../types';

export interface DetectedFace {
  id: string;
  x: number; // Top-left, as percentages of the displayed image.
  y: number;
  width: number;
  height: number;
  confidence: number;
}

// This associates positions already tagged in THIS image; it does not compare faces.
export const hasFaceTag = (face: DetectedFace, tags: FaceTag[]): boolean => tags.some(tag =>
  tag.x >= face.x && tag.x <= face.x + face.width && tag.y >= face.y && tag.y <= face.y + face.height);

export async function detectFaces(source: string, options: { signal: AbortSignal; onProgress?: (phase: 'loading' | 'detecting') => void }): Promise<DetectedFace[]> {
  const { signal, onProgress } = options;
  signal.throwIfAborted();
  onProgress?.('loading');
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error('Could not read the photo.');
  const image = await createImageBitmap(await response.blob());
  if (signal.aborted) { image.close(); signal.throwIfAborted(); }
  let worker: Worker;
  try { worker = new Worker(new URL('../workers/faceDetection.worker.ts', import.meta.url), { type: 'module' }); }
  catch (error) { image.close(); throw error; }
  let transferred = false;
  try {
    return await new Promise<DetectedFace[]>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (error?: unknown, faces?: DetectedFace[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(faces || []);
      };
      const abort = () => finish(new DOMException('Face detection cancelled', 'AbortError'));
      timeout = setTimeout(() => finish(new Error('Face detection timed out.')), 45000);
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = event => {
        if (event.data.type === 'progress') onProgress?.(event.data.phase);
        else if (event.data.type === 'result') finish(undefined, event.data.faces);
        else if (event.data.type === 'error') finish(new Error('Face detection unavailable.'));
      };
      worker.onerror = event => finish(new Error(event.message || 'Face detector worker failed.'));
      const assetBase = new URL(`${import.meta.env.BASE_URL}face-detection/`, window.location.origin).href;
      try { worker.postMessage({ image, assetBase }, [image]); transferred = true; }
      catch (error) { finish(error); }
      if (signal.aborted) abort();
    });
  } finally {
    worker.terminate();
    if (!transferred) image.close();
  }
}
