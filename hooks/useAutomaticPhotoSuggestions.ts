import { useEffect, useRef, useState } from 'react';
import type { FamilyTreePerson, Photo } from '../types';
import { SFACE_MODEL_ID } from '../services/faceRecognition';
import { validSimilarityIndex } from '../services/sceneEmbedding';
import { validFaceIndex } from '../utils/faceMatching';
import type { SuggestionDomains } from '../utils/automaticPhotoSuggestions';

interface IndexingState { completed: number; total: number; failed: number; paused: boolean; clearing?: boolean }
interface Options {
  photos: Photo[];
  familyPeople: FamilyTreePerson[];
  enabled: boolean;
  archiveKey: number | string;
  faceIndexing: IndexingState;
  sceneIndexing: IndexingState;
  getCurrentPhoto: (id: string) => Photo | undefined;
  onApply: (photo: Photo, domains: SuggestionDomains, isCurrent: () => boolean) => Promise<void>;
}

/** Applies only upload opt-ins, independently of whether the editor is open. */
export function useAutomaticPhotoSuggestions(options: Options) {
  const live = useRef(options); live.current = options;
  const busy = useRef(false);
  const mounted = useRef(false);
  const failures = useRef(new Set<string>());
  const archive = useRef(options.archiveKey);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(retryTimer.current); };
  }, []);
  useEffect(() => {
    if (archive.current !== options.archiveKey) { archive.current = options.archiveKey; failures.current.clear(); }
    if (!options.enabled || busy.current) return;
    const archiveKey = options.archiveKey;
    const valid = () => mounted.current && live.current.enabled && live.current.archiveKey === archiveKey;
    const ready = (photo: Photo): SuggestionDomains => {
      const { faceIndexing: face, sceneIndexing: scene } = live.current;
      return {
        faces: Boolean(photo.autoSuggestions?.faces && !face.paused && !face.clearing && face.completed + face.failed >= face.total && validFaceIndex(photo.faceRecognition, SFACE_MODEL_ID)),
        metadata: Boolean(photo.autoSuggestions?.metadata && !scene.paused && scene.completed + scene.failed >= scene.total && validSimilarityIndex(photo)),
      };
    };
    const next = () => {
      for (const snapshot of live.current.photos) {
        if (failures.current.has(snapshot.id)) continue;
        const photo = live.current.getCurrentPhoto(snapshot.id);
        if (!photo) continue;
        const domains = ready(photo);
        if (domains.faces || domains.metadata) return { photo, domains };
      }
      return undefined;
    };
    if (!next()) return;
    busy.current = true;
    void (async () => {
      while (valid()) {
        const candidate = next();
        if (!candidate) break;
        const { photo, domains } = candidate;
        const isCurrent = () => {
          const current = live.current.getCurrentPhoto(photo.id);
          const allowed = current && ready(current);
          return Boolean(valid() && current?.originalUrl === photo.originalUrl && current?.originalRevision === photo.originalRevision &&
            (!domains.faces || allowed?.faces) && (!domains.metadata || allowed?.metadata));
        };
        try {
          await live.current.onApply(photo, domains, isCurrent);
          if (isCurrent()) throw new Error('The automatic suggestion write did not complete.');
        }
        catch (error) {
          if (!valid()) break;
          failures.current.add(photo.id);
          console.warn('Could not save automatic photo suggestions. They will be retried.', error);
          clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => { failures.current.clear(); if (mounted.current) setRevision(value => value + 1); }, 10000);
        }
      }
    })().finally(() => {
      busy.current = false;
      if (mounted.current) setRevision(value => value + 1);
    });
  }, [options.photos, options.familyPeople, options.enabled, options.archiveKey, options.faceIndexing.completed, options.faceIndexing.failed,
    options.faceIndexing.paused, options.faceIndexing.clearing, options.sceneIndexing.completed, options.sceneIndexing.failed, options.sceneIndexing.paused, revision]);
}
