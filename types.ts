
export interface FaceTag {
  id: string;
  name: string;
  personId?: string; // Stable family-tree identity when available.
  aiSuggested?: boolean; // Tentative until a user confirms this identity.
  aiAddedPerson?: boolean; // Whether the tentative tag also introduced the photo-level name.
  x: number; // Percentage 0-100
  y: number; // Percentage 0-100
}

export interface FaceRecognitionIndex {
  modelId: string;
  faces: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    confidence: number;
    embedding: number[];
  }>;
}

export interface SceneDescriptor {
  embedding: number[];
  gray: number[];
  mean: number;
  deviation: number;
  saturation: number;
  aspect: number;
}

export interface PhotoSimilarityIndex {
  modelId: string;
  preprocessingVersion: number;
  originalRevision: string;
  descriptor: SceneDescriptor;
}

export interface AiMetadataValue {
  value: string;
  sourcePhotoIds: string[];
}

export interface Photo {
  id: string;
  originalUrl: string; // Base64 or Blob URL
  originalRevision?: string; // Stable across sessions; changes only with the original image.
  restoredUrl?: string; // Base64 or Blob URL
  thumbnailUrl?: string; // Small persisted preview; never used for editing or export
  thumbnailSource?: 'original' | 'restored';
  fileName: string;
  uploadDate: number;
  
  // Metadata
  description: string;
  location?: string;
  people: string[];
  tags: string[];
  faceTags: FaceTag[]; // Spatial tags
  faceRecognition?: FaceRecognitionIndex; // Derived only from the current original scan.
  similarityIndex?: PhotoSimilarityIndex;
  dateOfPhoto: string; // YYYY, YYYY-MM, YYYY-MM-DD, or an empty string when unknown.
  
  // Automatic application is opted into only for photos uploaded in automatic mode.
  autoSuggestions?: { faces: boolean; metadata: boolean };
  aiMetadata?: { dateOfPhoto?: AiMetadataValue; location?: AiMetadataValue };

  // State
  isRestoring: boolean;
}

export interface FilterState {
  searchTerm: string;
  person: string | null;
  tag: string | null;
  startDate: string;
  endDate: string;
}

export type ViewMode = 'gallery' | 'upload' | 'view' | 'tree';

export type Language = 'en' | 'sk';

export type StorageType = 'local' | 'cloud' | 'filesystem';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export interface AppSettings {
  suggestionMode?: 'manual' | 'automatic'; // Existing installations remain manual.
  language: Language;
  storageType: StorageType;
  firebaseConfig?: FirebaseConfig;
}
export interface AvatarCrop {
  x: number; // Center as a percentage of the full image.
  y: number;
  zoom: number; // Relative to a square covering the shorter image dimension.
}

export interface FamilyTreePerson {
  id: string;
  name: string; // Combined display name, also used by existing photo tags.
  firstName?: string;
  lastName?: string;
  maidenName?: string; // Missing inherits from the father; an empty string is an explicit blank.
  descriptionName?: string; // Preferred wording in generated captions; not a photo-tag identity.
  locations?: string[]; // Optional places associated with this person.
  location?: string; // Legacy single location, migrated when loading the tree.
  avatarCrop?: AvatarCrop;
  avatarPhotoId?: string; // Archive photo reference; never persist a session Blob URL.
  birthDate?: string; // YYYY, YYYY-MM, YYYY-MM-DD, or --MM when only the month is known.
  deathDate?: string;
  relationshipGender?: 'male' | 'female'; // Optional preference for gendered relationship titles.
}

export interface FamilyTreeFamily {
  id: string;
  parentIds: string[];
  childIds: string[];
}

export interface FamilyTreeData {
  rootId: string | null;
  people: FamilyTreePerson[];
  families: FamilyTreeFamily[];
}

export interface PhotoDescriptionPerson {
  name: string;
  descriptionName: string;
}
