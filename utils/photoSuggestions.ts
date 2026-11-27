import type { Photo } from '../types';
import { isPartialDate } from './partialDates';

export type SimilarityReason = 'composition' | 'appearance' | 'format' | 'series' | 'scene' | 'objects' | 'setting';
export interface SimilarPhotoMatch {
  photoId: string;
  similarity: number;
  reasons: SimilarityReason[];
  confidence: 'strong' | 'possible';
  dateEvidence: boolean;
  locationEvidence: boolean;
}
export interface MetadataSuggestion {
  value: string;
  confidence: 'strong' | 'possible';
  sourcePhotoIds: string[];
  reasons: SimilarityReason[];
  method: 'visual' | 'ai';
}
export interface PhotoMetadataSuggestions {
  dates: MetadataSuggestion[];
  locations: MetadataSuggestion[];
  matches: SimilarPhotoMatch[];
  method: 'visual' | 'ai';
  compared: number;
  skipped: number;
}

const reasons = new Set<SimilarityReason>(['composition', 'appearance', 'format', 'series', 'scene', 'objects', 'setting']);
const usableDate = (value: unknown): value is string => isPartialDate(value) && !value.startsWith('--');
const cleanLocation = (value?: string) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const locationKey = (value?: string) => cleanLocation(value).toLocaleLowerCase();
const conflictingDates = (a: string, b: string) => a !== b && !a.startsWith(`${b}-`) && !b.startsWith(`${a}-`);

/** Values always come from a current reference record, never from an AI guess. */
export function buildMetadataSuggestions(
  target: Photo, archivePhotos: Photo[], matches: SimilarPhotoMatch[], method: 'visual' | 'ai',
  counts?: { compared: number; skipped: number },
): PhotoMetadataSuggestions {
  const photos = new Map(archivePhotos.filter(photo => photo.id !== target.id).map(photo => [photo.id, photo]));
  const byPhoto = new Map<string, SimilarPhotoMatch>();
  for (const match of matches) {
    if (!photos.has(match.photoId) || !Number.isFinite(match.similarity) || match.similarity < 0 || match.similarity > 1 ||
        !Array.isArray(match.reasons) || !match.reasons.some(reason => reasons.has(reason))) continue;
    if ((byPhoto.get(match.photoId)?.similarity ?? -1) >= match.similarity) continue;
    byPhoto.set(match.photoId, { ...match, reasons: [...new Set(match.reasons.filter(reason => reasons.has(reason)))] });
  }
  const currentMatches = [...byPhoto.values()].sort((a, b) => b.similarity - a.similarity || a.photoId.localeCompare(b.photoId));
  const collect = (field: 'dateOfPhoto' | 'location'): MetadataSuggestion[] => {
    const groups = new Map<string, { suggestion: MetadataSuggestion; score: number }>();
    for (const match of currentMatches) {
      if (!(field === 'dateOfPhoto' ? match.dateEvidence : match.locationEvidence)) continue;
      const photo = photos.get(match.photoId)!;
      const value = field === 'dateOfPhoto' ? (usableDate(photo.dateOfPhoto) ? photo.dateOfPhoto : '') : cleanLocation(photo.location);
      if (!value) continue;
      const key = field === 'dateOfPhoto' ? value : locationKey(value);
      const current = field === 'dateOfPhoto' ? target.dateOfPhoto : locationKey(target.location);
      if (key === current) continue;
      let group = groups.get(key);
      if (!group) {
        group = { suggestion: { value, confidence: 'possible', sourcePhotoIds: [], reasons: [], method }, score: match.similarity };
        groups.set(key, group);
      }
      group.score = Math.max(group.score, match.similarity);
      group.suggestion.sourcePhotoIds.push(match.photoId);
      group.suggestion.reasons = [...new Set([...group.suggestion.reasons, ...match.reasons])];
      // Low-level visual similarity is useful evidence but cannot establish that
      // two photos were made at the same time or place.
      if (method === 'ai' && match.confidence === 'strong' && match.similarity >= 0.85) group.suggestion.confidence = 'strong';
    }
    const ranked = [...groups.values()].sort((a, b) => b.score - a.score || b.suggestion.sourcePhotoIds.length - a.suggestion.sourcePhotoIds.length || a.suggestion.value.localeCompare(b.suggestion.value));
    // Similar evidence for incompatible values stays explicitly tentative.
    for (const group of ranked) if (ranked.some(other => other !== group && Math.abs(other.score - group.score) < 0.08 &&
      (field === 'dateOfPhoto' ? conflictingDates(group.suggestion.value, other.suggestion.value) : true))) group.suggestion.confidence = 'possible';
    return ranked.slice(0, 3).map(group => group.suggestion);
  };
  return { dates: collect('dateOfPhoto'), locations: collect('location'), matches: currentMatches, method,
    compared: counts?.compared ?? currentMatches.length, skipped: counts?.skipped ?? 0 };
}
