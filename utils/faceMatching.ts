import type { FaceRecognitionIndex, FamilyTreePerson, Photo } from '../types';
import { normalizePersonName, personNameKey } from './people';

// Starting thresholds for reviewed suggestions, not calibrated probabilities.
// Validate these against representative archive photos before changing them.
export const FACE_MATCH_THRESHOLD = 0.55;
export const FACE_MATCH_MARGIN = 0.08;

export interface FaceReference {
  name: string;
  personId?: string;
  embedding: number[];
  photoId: string;
  faceId: string;
}
export interface FaceSuggestion { name: string; personId?: string; similarity: number }
type IndexedFace = FaceRecognitionIndex['faces'][number];

const validEmbedding = (value: unknown): value is number[] => {
  if (!Array.isArray(value) || value.length !== 128 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) return false;
  const squaredNorm = value.reduce((sum, v) => sum + v * v, 0);
  // Inference emits unit vectors; allow rounding in JSON exports.
  return squaredNorm >= 0.9 && squaredNorm <= 1.1;
};
const validFace = (value: unknown): value is IndexedFace => {
  if (!value || typeof value !== 'object') return false;
  const face = value as IndexedFace;
  return typeof face.id === 'string' && !!face.id &&
    [face.x, face.y, face.width, face.height, face.confidence].every(v => typeof v === 'number' && Number.isFinite(v)) &&
    face.x >= 0 && face.y >= 0 && face.width > 0 && face.height > 0 &&
    face.x + face.width <= 100.001 && face.y + face.height <= 100.001 &&
    face.confidence >= 0 && face.confidence <= 1 && validEmbedding(face.embedding);
};

export const validFaceIndex = (value: unknown, modelId: string): value is FaceRecognitionIndex => {
  if (!value || typeof value !== 'object') return false;
  const index = value as FaceRecognitionIndex;
  return index.modelId === modelId && Array.isArray(index.faces) && index.faces.every(validFace) &&
    new Set(index.faces.map(face => face.id)).size === index.faces.length;
};

// Only a user-confirmed spatial tag can enroll a face. Photo-level names do not
// indicate which face belongs to a person; overlapping or multiply tagged boxes
// are also intentionally excluded from enrollment.
export const buildFaceReferences = (
  photos: Photo[], familyPeople: FamilyTreePerson[], modelId: string, excludePhotoId?: string,
): FaceReference[] => {
  const byId = new Map(familyPeople.map(person => [person.id, person]));
  const byName = new Map<string, FamilyTreePerson[]>();
  for (const person of familyPeople) {
    const key = personNameKey(person.name);
    byName.set(key, [...(byName.get(key) || []), person]);
  }
  const result: FaceReference[] = [];
  for (const photo of photos) {
    if (photo.id === excludePhotoId || !validFaceIndex(photo.faceRecognition, modelId)) continue;
    const faces = photo.faceRecognition.faces;
    const associations = (photo.faceTags || []).filter(tag => !tag.aiSuggested && typeof tag.name === 'string' && Number.isFinite(tag.x) && Number.isFinite(tag.y)).map(tag => ({
      tag, faces: faces.filter(face => tag.x >= face.x && tag.x <= face.x + face.width && tag.y >= face.y && tag.y <= face.y + face.height),
    }));
    for (const association of associations) {
      if (association.faces.length !== 1) continue;
      const face = association.faces[0];
      if (associations.filter(item => item.faces.includes(face)).length !== 1) continue;
      const tag = association.tag;
      const namedPeople = byName.get(personNameKey(tag.name)) || [];
      const person = (tag.personId ? byId.get(tag.personId) : undefined) || (namedPeople.length === 1 ? namedPeople[0] : undefined);
      // A legacy name cannot disambiguate two tree people with identical names.
      if (!person && namedPeople.length > 1) continue;
      const name = normalizePersonName(person?.name || tag.name);
      if (!name) continue;
      result.push({ name, ...(person ? { personId: person.id } : {}), embedding: face.embedding, photoId: photo.id, faceId: face.id });
    }
  }
  return result;
};

const cosine = (a: number[], b: number[]): number => {
  let dot = 0, aa = 0, bb = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index]; aa += a[index] * a[index]; bb += b[index] * b[index];
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
};

export const suggestFace = (
  face: { embedding: number[] }, references: FaceReference[],
  options: { threshold?: number; margin?: number } = {},
): FaceSuggestion | null => {
  if (!validEmbedding(face.embedding)) return null;
  const threshold = options.threshold ?? FACE_MATCH_THRESHOLD;
  const margin = options.margin ?? FACE_MATCH_MARGIN;
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1 || !Number.isFinite(margin) || margin < 0) return null;
  const identities = new Map<string, FaceSuggestion>();
  for (const reference of references) {
    if (!validEmbedding(reference.embedding) || typeof reference.name !== 'string' || !normalizePersonName(reference.name)) continue;
    const identity = reference.personId ? `id:${reference.personId}` : `name:${personNameKey(reference.name)}`;
    const similarity = cosine(face.embedding, reference.embedding);
    if (similarity > (identities.get(identity)?.similarity ?? -Infinity)) {
      identities.set(identity, { name: reference.name, ...(reference.personId ? { personId: reference.personId } : {}), similarity });
    }
  }
  const ranked = [...identities.values()].sort((a, b) => b.similarity - a.similarity);
  if (!ranked.length || ranked[0].similarity < threshold || (ranked[1] && ranked[0].similarity - ranked[1].similarity < margin)) return null;
  return ranked[0];
};
