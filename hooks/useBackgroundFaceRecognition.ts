import { useCallback, useEffect, useRef, useState } from 'react';
import type { FaceRecognitionIndex, Photo } from '../types';
import { createFaceRecognizer, SFACE_MODEL_ID } from '../services/faceRecognition';
import { validFaceIndex } from '../utils/faceMatching';
import { runImageInference } from '../services/inferenceScheduler';

interface Options {
  photos: Photo[];
  enabled: boolean;
  archiveKey: number | string;
  priorityPhotoId?: string;
  getCurrentPhoto: (id: string) => Photo | undefined;
  onSaveIndex: (photo: Photo, index: FaceRecognitionIndex | null) => Promise<void>;
}

type Recognizer = ReturnType<typeof createFaceRecognizer>;
interface Drain {
  archiveKey: Options['archiveKey'];
  controller: AbortController;
  recognizer?: Recognizer;
  photoId: string | null;
  source?: string;
  promise: Promise<void>;
}
const PAUSE_KEY = 'ancestry-lens-recognition-paused';
const initiallyPaused = () => {
  try { return localStorage.getItem(PAUSE_KEY) === 'true'; }
  catch { return false; }
};
const yieldToApp = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, 50);
  const abort = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    reject(new DOMException('Face recognition cancelled', 'AbortError'));
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

/** One serial archive queue; face signatures never assign a person's name. */
export function useBackgroundFaceRecognition(options: Options) {
  const live = useRef(options); live.current = options;
  const mounted = useRef(false);
  const active = useRef<Drain | null>(null);
  const archive = useRef(options.archiveKey);
  const failures = useRef(new Map<string, string>());
  const manualPriority = useRef<string | null>(null);
  const clearController = useRef<AbortController | null>(null);
  const clearingRef = useRef(false);
  const [paused, setPaused] = useState(initiallyPaused);
  const pausedRef = useRef(paused);
  const [activity, setActivity] = useState({ running: false, currentPhotoId: null as string | null });
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const wake = useCallback(() => { if (mounted.current) setRevision(value => value + 1); }, []);

  const persistPause = useCallback((value: boolean) => {
    pausedRef.current = value;
    try { localStorage.setItem(PAUSE_KEY, String(value)); }
    catch { /* Keep the control usable when browser storage is unavailable. */ }
    if (mounted.current) setPaused(value);
  }, []);
  const stop = useCallback(() => {
    const run = active.current;
    run?.controller.abort();
    run?.recognizer?.dispose();
    if (mounted.current) setActivity({ running: false, currentPhotoId: null });
  }, []);
  const pause = useCallback(() => { persistPause(true); stop(); }, [persistPause, stop]);
  const resume = useCallback(() => {
    if (clearingRef.current) return;
    persistPause(false); wake();
  }, [persistPause, wake]);
  const retry = useCallback(() => {
    failures.current.clear();
    if (mounted.current) setError(false);
    wake();
  }, [wake]);
  const prioritize = useCallback((id: string) => { manualPriority.current = id; wake(); }, [wake]);

  const clear = useCallback(async () => {
    if (clearingRef.current || !mounted.current) return;
    persistPause(true);
    clearingRef.current = true;
    setClearing(true);
    setError(false);
    const controller = new AbortController();
    clearController.current = controller;
    const archiveKey = live.current.archiveKey;
    const valid = () => mounted.current && live.current.enabled && !controller.signal.aborted && live.current.archiveKey === archiveKey;
    const run = active.current;
    stop();
    try {
      // A storage commit cannot be aborted midway. Let it settle before removing
      // signatures so its late completion cannot recreate a cleared record.
      await run?.promise;
      if (!valid()) return;
      const ids = live.current.photos.map(photo => photo.id);
      for (const id of ids) {
        if (!valid()) return;
        const photo = live.current.getCurrentPhoto(id);
        if (photo?.faceRecognition) await live.current.onSaveIndex(photo, null);
      }
      if (valid()) failures.current.clear();
    } catch (failure) {
      if (valid()) { console.warn('Could not clear saved face signatures.', failure); setError(true); }
    } finally {
      if (clearController.current === controller) {
        clearController.current = null;
        clearingRef.current = false;
        if (mounted.current) setClearing(false);
        wake();
      }
    }
  }, [persistPause, stop, wake]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current?.recognizer?.dispose();
      clearController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!options.enabled) clearController.current?.abort();
    if (archive.current !== options.archiveKey) {
      archive.current = options.archiveKey;
      failures.current.clear();
      manualPriority.current = null;
      clearController.current?.abort();
      setError(false);
    }
    // Replacement and deletion invalidate previous failures just like indices.
    for (const [id, source] of failures.current) {
      if (options.getCurrentPhoto(id)?.originalUrl !== source) failures.current.delete(id);
    }
    const allowed = () => mounted.current && live.current.enabled && !pausedRef.current && !clearingRef.current;
    const running = active.current;
    if (running) {
      if (!allowed() || running.archiveKey !== options.archiveKey ||
        (running.photoId !== null && live.current.getCurrentPhoto(running.photoId)?.originalUrl !== running.source)) stop();
      return;
    }
    if (!allowed()) return;

    const nextPhoto = (): Photo | undefined => {
      // Avoid calling an archive's potentially linear getCurrentPhoto lookup for
      // every indexed record on each job. Resolve only plausible candidates,
      // then recheck their live source/cache before selecting them.
      const pending = live.current.photos.filter(photo => !validFaceIndex(photo.faceRecognition, SFACE_MODEL_ID) &&
        failures.current.get(photo.id) !== photo.originalUrl);
      const resolve = (snapshot?: Photo) => {
        const current = snapshot && live.current.getCurrentPhoto(snapshot.id);
        return current && !validFaceIndex(current.faceRecognition, SFACE_MODEL_ID) &&
          failures.current.get(current.id) !== current.originalUrl ? current : undefined;
      };
      const priority = manualPriority.current || live.current.priorityPhotoId;
      const selected = resolve(pending.find(photo => photo.id === priority));
      if (selected) return selected;
      if (manualPriority.current) manualPriority.current = null;
      const openPhoto = resolve(pending.find(photo => photo.id === live.current.priorityPhotoId));
      if (openPhoto) return openPhoto;
      for (const photo of pending) if (photo.faceTags?.length) {
        const current = resolve(photo); if (current) return current;
      }
      for (const photo of pending) {
        const current = resolve(photo); if (current) return current;
      }
      return undefined;
    };
    if (!nextPhoto()) return;
    const run: Drain = { archiveKey: options.archiveKey, controller: new AbortController(), photoId: null, promise: Promise.resolve() };
    active.current = run;
    setActivity({ running: true, currentPhotoId: null });
    const valid = () => active.current === run && allowed() && !run.controller.signal.aborted && live.current.archiveKey === run.archiveKey;
    run.promise = Promise.resolve().then(async () => {
      while (valid()) {
        const source = nextPhoto();
        if (!source) break;
        run.photoId = source.id; run.source = source.originalUrl;
        setActivity({ running: true, currentPhotoId: source.id });
        try {
          await yieldToApp(run.controller.signal);
          if (!valid()) break;
          const current = live.current.getCurrentPhoto(source.id);
          if (!current || current.originalUrl !== source.originalUrl || validFaceIndex(current.faceRecognition, SFACE_MODEL_ID)) continue;
          run.recognizer ||= createFaceRecognizer();
          const index: FaceRecognitionIndex = {
            modelId: SFACE_MODEL_ID,
            faces: await runImageInference(() => run.recognizer!.recognize(source.originalUrl, { signal: run.controller.signal }),
              { signal: run.controller.signal, priority: source.id === live.current.priorityPhotoId ? 5 : 0 }),
          };
          if (!valid()) break;
          if (!validFaceIndex(index, SFACE_MODEL_ID)) throw new Error('Invalid face recognition result');
          const latest = live.current.getCurrentPhoto(source.id);
          if (!latest || latest.originalUrl !== source.originalUrl) continue;
          await live.current.onSaveIndex(latest, index);
          if (valid()) { failures.current.delete(source.id); wake(); }
        } catch (failure) {
          if (!valid()) break;
          if (live.current.getCurrentPhoto(source.id)?.originalUrl === source.originalUrl) {
            failures.current.set(source.id, source.originalUrl);
            console.warn('Could not index a photo for face recognition.', failure);
            setError(true); wake();
          }
          // A failed/timed-out worker must not poison the remainder of the queue.
          run.recognizer?.dispose(); run.recognizer = undefined;
        }
      }
    }).finally(() => {
      run.recognizer?.dispose();
      if (active.current === run) {
        active.current = null;
        if (mounted.current) setActivity({ running: false, currentPhotoId: null });
        wake();
      }
    });
  }, [options.photos, options.enabled, options.archiveKey, options.priorityPhotoId, paused, clearing, revision, stop, wake]);

  return {
    ...activity, paused, clearing, error,
    completed: options.photos.filter(photo => validFaceIndex(photo.faceRecognition, SFACE_MODEL_ID)).length,
    total: options.photos.length,
    failed: options.photos.filter(photo => failures.current.get(photo.id) === photo.originalUrl && !validFaceIndex(photo.faceRecognition, SFACE_MODEL_ID)).length,
    pause, resume, retry, prioritize, clear,
  };
}


