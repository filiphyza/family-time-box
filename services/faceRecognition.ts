/** Face signatures are versioned with both weights and alignment/preprocessing. */
export const SFACE_MODEL_ID = 'sface-2021dec-0ba9fbfa-yunet5-v1';

export interface RecognitionFace {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  embedding: number[];
}

export interface RecognitionOptions {
  signal: AbortSignal;
  onProgress?: (phase: 'loading' | 'recognizing') => void;
}

/** Keep this session for a scan, then dispose it to release the model's memory. */
export function createFaceRecognizer() {
  let worker: Worker | undefined;
  let disposed = false;
  let busy = false;
  let rejectPending: ((reason: unknown) => void) | undefined;
  const dispose = () => {
    disposed = true;
    worker?.terminate();
    worker = undefined;
    rejectPending?.(new DOMException('Face recognition cancelled', 'AbortError'));
  };
  return {
    dispose,
    async recognize(source: string, { signal, onProgress }: RecognitionOptions): Promise<RecognitionFace[]> {
      signal.throwIfAborted();
      if (disposed) throw new DOMException('Face recognizer was disposed', 'AbortError');
      if (busy) throw new Error('Use one photo at a time in each recognition session.');
      busy = true;
      let image: ImageBitmap | undefined;
      let transferred = false;
      try {
        onProgress?.('loading');
        const response = await fetch(source, { signal });
        if (!response.ok) throw new Error('Could not read the original photo.');
        image = await createImageBitmap(await response.blob());
        signal.throwIfAborted();
        if (disposed) throw new DOMException('Face recognizer was disposed', 'AbortError');
        worker ||= new Worker(new URL('../workers/faceRecognition.worker.ts', import.meta.url), { type: 'module' });
        return await new Promise<RecognitionFace[]>((resolve, reject) => {
          let settled = false;
          let timeout: ReturnType<typeof setTimeout>;
          const finish = (error?: unknown, faces?: RecognitionFace[]) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            rejectPending = undefined;
            if (error) reject(error); else resolve(faces || []);
          };
          const abort = () => { finish(new DOMException('Face recognition cancelled', 'AbortError')); dispose(); };
          rejectPending = error => finish(error);
          timeout = setTimeout(() => {
            finish(new Error('Face recognition timed out.'));
            dispose();
          }, 180000);
          signal.addEventListener('abort', abort, { once: true });
          worker!.onmessage = event => {
            if (event.data.type === 'progress') onProgress?.(event.data.phase);
            else if (event.data.type === 'result') finish(undefined, event.data.faces);
            else if (event.data.type === 'error') finish(new Error(event.data.message || 'Face recognition unavailable.'));
          };
          worker!.onerror = event => { finish(new Error(event.message || 'Face recognition worker failed.')); dispose(); };
          worker!.onmessageerror = () => { finish(new Error('Could not read face recognition results.')); dispose(); };
          const assetBase = new URL(`${import.meta.env.BASE_URL}face-recognition/`, window.location.origin).href;
          try { worker!.postMessage({ image, assetBase }, [image!]); transferred = true; }
          catch (error) { finish(error); dispose(); }
          if (signal.aborted) abort();
        });
      } finally {
        busy = false;
        if (!transferred) image?.close();
      }
    },
  };
}

export async function recognizeFaces(source: string, options: RecognitionOptions): Promise<RecognitionFace[]> {
  const recognizer = createFaceRecognizer();
  try { return await recognizer.recognize(source, options); }
  finally { recognizer.dispose(); }
}
