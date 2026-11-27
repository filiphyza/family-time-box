import type { FamilyTreePerson, Photo } from '../types';
import { SFACE_MODEL_ID } from '../services/faceRecognition';
import { hasFaceTag } from '../services/faceDetection';
import { matchIndexedPhotoScenes, validSimilarityIndex } from '../services/sceneEmbedding';
import { buildFaceReferences, suggestFace, validFaceIndex } from './faceMatching';
import { buildMetadataSuggestions, type MetadataSuggestion } from './photoSuggestions';
import { personNameKey } from './people';

export interface SuggestionDomains { faces: boolean; metadata: boolean }

/** Tentative metadata cannot become evidence for another tentative assignment. */
export const confirmedMetadataReferences = (photos: Photo[]): Photo[] => photos.map(photo => {
  const date = photo.aiMetadata?.dateOfPhoto?.value === photo.dateOfPhoto;
  const location = Boolean(photo.aiMetadata?.location && photo.aiMetadata.location.value === photo.location);
  return date || location ? { ...photo, ...(date ? { dateOfPhoto: '' } : {}), ...(location ? { location: '' } : {}) } : photo;
});

const compatibleDates = (a: string, b: string) => a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
const unambiguous = (suggestions: MetadataSuggestion[], dates: boolean) => {
  const first = suggestions[0];
  if (!first || suggestions.some(other => dates ? !compatibleDates(first.value, other.value) : other.value !== first.value)) return undefined;
  return first;
};

/** Pure transformation; callers decide when the archive's indexing is ready. */
export function applyAutomaticPhotoSuggestions(photo: Photo, archivePhotos: Photo[], familyPeople: FamilyTreePerson[], domains: SuggestionDomains): Photo {
  const faces = Boolean(domains.faces && photo.autoSuggestions?.faces && validFaceIndex(photo.faceRecognition, SFACE_MODEL_ID));
  const metadata = Boolean(domains.metadata && photo.autoSuggestions?.metadata && validSimilarityIndex(photo));
  if (!faces && !metadata) return photo;
  const next: Photo = { ...photo, autoSuggestions: { ...photo.autoSuggestions!,
    ...(faces ? { faces: false } : {}), ...(metadata ? { metadata: false } : {}) } };
  if (faces) {
    const references = buildFaceReferences(archivePhotos, familyPeople, SFACE_MODEL_ID, photo.id);
    const tags = [...(photo.faceTags || [])];
    const people = [...(photo.people || [])];
    for (const face of photo.faceRecognition!.faces) {
      if (hasFaceTag(face, tags)) continue;
      const match = suggestFace(face, references);
      if (!match || tags.some(tag => match.personId && tag.personId ? tag.personId === match.personId : personNameKey(tag.name) === personNameKey(match.name))) continue;
      const addedPerson = !people.some(name => personNameKey(name) === personNameKey(match.name));
      tags.push({ id: crypto.randomUUID(), name: match.name, ...(match.personId ? { personId: match.personId } : {}),
        x: face.x + face.width / 2, y: face.y + face.height / 2, aiSuggested: true, ...(addedPerson ? { aiAddedPerson: true } : {}) });
      if (addedPerson) people.push(match.name);
    }
    next.faceTags = tags;
    next.people = people;
  }
  if (metadata) {
    const references = confirmedMetadataReferences(archivePhotos);
    const matches = matchIndexedPhotoScenes(photo, references) || [];
    const suggestions = buildMetadataSuggestions(photo, references, matches, 'ai');
    const date = !photo.dateOfPhoto?.trim() && unambiguous(suggestions.dates, true);
    const location = !photo.location?.trim() && unambiguous(suggestions.locations, false);
    if (date || location) next.aiMetadata = { ...photo.aiMetadata };
    if (date) { next.dateOfPhoto = date.value; next.aiMetadata!.dateOfPhoto = { value: date.value, sourcePhotoIds: date.sourcePhotoIds }; }
    if (location) { next.location = location.value; next.aiMetadata!.location = { value: location.value, sourcePhotoIds: location.sourcePhotoIds }; }
  }
  return next;
}
