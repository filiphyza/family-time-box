import { useCallback, useEffect, useRef, useState } from 'react';
import type { Photo, PhotoSimilarityIndex } from '../types';
import { createSceneEmbedder, createSimilarityIndex, similaritySourceRevision, validSimilarityIndex } from '../services/sceneEmbedding';

interface Options {
  photos: Photo[];
  enabled: boolean;
  archiveKey: number | string;
  priorityPhotoId?: string;
  getCurrentPhoto: (id: string) => Photo | undefined;
  onSaveIndex: (photo: Photo, index: PhotoSimilarityIndex | null) => Promise<void>;
}
interface Drain {
  archiveKey: Options['archiveKey'];
  controller: AbortController;
  embedder: ReturnType<typeof createSceneEmbedder>;
  photoId: string | null;
  source?: string;
  originalRevision?: string;
  promise: Promise<void>;
}
const PAUSE_KEY = 'ancestry-lens-similarity-paused';
const initiallyPaused = () => {
  try { return localStorage.getItem(PAUSE_KEY) === 'true'; }
  catch { return false; }
};
const sourceMatches = (photo: Photo | undefined, source: string | undefined, revision: string | undefined) =>
  Boolean(photo && photo.originalUrl === source && similaritySourceRevision(photo) === revision);

/** Persistent fingerprints for every original; names and metadata are never assigned by this queue. */
export function useBackgroundPhotoSimilarity(options: Options) {
  const live = useRef(options); live.current = options;
  const mounted = useRef(false);
  const active = useRef<Drain | null>(null);
  const archive = useRef(options.archiveKey);
  const failures = useRef(new Map<string, { source: string; revision: string }>());
  const [paused, setPaused] = useState(initiallyPaused);
  const pausedRef = useRef(paused);
  const [activity, setActivity] = useState({ running: false, currentPhotoId: null as string | null });
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const wake = useCallback(() => { if (mounted.current) setRevision(value => value + 1); }, []);
  const stop = useCallback(() => {
    active.current?.controller.abort();
    active.current?.embedder.dispose();
    if (mounted.current) setActivity({ running: false, currentPhotoId: null });
  }, []);
  const persistPause = useCallback((value: boolean) => {
    pausedRef.current = value;
    try { localStorage.setItem(PAUSE_KEY, String(value)); } catch { /* Session pause still works. */ }
    if (mounted.current) setPaused(value);
  }, []);
  const pause = useCallback(() => { persistPause(true); stop(); }, [persistPause, stop]);
  const resume = useCallback(() => { persistPause(false); wake(); }, [persistPause, wake]);
  const retry = useCallback(() => {
    failures.current.clear();
    if (mounted.current) setError(false);
    wake();
  }, [wake]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.controller.abort(); active.current?.embedder.dispose(); };
  }, []);

  useEffect(() => {
    if (archive.current !== options.archiveKey) {
      archive.current = options.archiveKey;
      failures.current.clear();
      setError(false);
    }
    for (const [id, failure] of failures.current) {
      if (!sourceMatches(options.getCurrentPhoto(id), failure.source, failure.revision)) failures.current.delete(id);
    }
    const allowed = () => mounted.current && live.current.enabled && !pausedRef.current;
    const running = active.current;
    if (running) {
      if (!allowed() || running.archiveKey !== options.archiveKey || (running.photoId !== null &&
        !sourceMatches(options.getCurrentPhoto(running.photoId), running.source, running.originalRevision))) stop();
      return;
    }
    if (!allowed()) return;
    const nextPhoto = () => {
      const pending = live.current.photos.filter(photo => !validSimilarityIndex(photo) && !failures.current.has(photo.id));
      const candidates = [pending.find(photo => photo.id === live.current.priorityPhotoId), ...pending];
      for (const snapshot of candidates) {
        if (!snapshot) continue;
        const photo = live.current.getCurrentPhoto(snapshot.id);
        if (photo && !validSimilarityIndex(photo) && !failures.current.has(photo.id)) return photo;
      }
      return undefined;
    };
    if (!nextPhoto()) return;
    const run: Drain = { archiveKey: options.archiveKey, controller: new AbortController(), embedder: createSceneEmbedder(), photoId: null, promise: Promise.resolve() };
    active.current = run;
    const valid = () => active.current === run && allowed() && !run.controller.signal.aborted && live.current.archiveKey === run.archiveKey;
    run.promise = Promise.resolve().then(async () => {
      while (valid()) {
        const source = nextPhoto();
        if (!source) break;
        run.photoId = source.id; run.source = source.originalUrl; run.originalRevision = similaritySourceRevision(source);
        setActivity({ running: true, currentPhotoId: source.id });
        try {
          // Yield between originals so edits and navigation can be processed.
          await new Promise<void>(resolve => setTimeout(resolve, 50));
          if (!valid() || !sourceMatches(live.current.getCurrentPhoto(source.id), run.source, run.originalRevision)) continue;
          const descriptor = await run.embedder.describe(source, run.controller.signal, source.id === live.current.priorityPhotoId ? 5 : 0);
          if (!valid() || !sourceMatches(live.current.getCurrentPhoto(source.id), run.source, run.originalRevision)) continue;
          const current = live.current.getCurrentPhoto(source.id);
          if (!current || validSimilarityIndex(current)) continue;
          await live.current.onSaveIndex(source, createSimilarityIndex(source, descriptor));
          failures.current.delete(source.id);
        } catch (failure) {
          if (!valid()) break;
          if (sourceMatches(live.current.getCurrentPhoto(source.id), run.source, run.originalRevision)) {
            failures.current.set(source.id, { source: source.originalUrl, revision: similaritySourceRevision(source) });
            console.warn('Could not index a photo for similarity.', failure);
            setError(true);
          }
          run.embedder.dispose();
        }
      }
    }).finally(() => {
      run.embedder.dispose();
      if (active.current === run) {
        active.current = null;
        if (mounted.current) setActivity({ running: false, currentPhotoId: null });
        wake();
      }
    });
  }, [options.photos, options.enabled, options.archiveKey, options.priorityPhotoId, paused, revision, stop, wake]);

  const failed = options.photos.filter(photo => failures.current.has(photo.id) && !validSimilarityIndex(photo)).length;
  return {
    ...activity, paused, error: error && failed > 0,
    currentFileName: options.photos.find(photo => photo.id === activity.currentPhotoId)?.fileName || '',
    completed: options.photos.filter(validSimilarityIndex).length,
    total: options.photos.length,
    failed,
    pause, resume, retry,
  };
}
