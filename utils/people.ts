import type { Photo, FamilyTreeData, FamilyTreePerson, PhotoDescriptionPerson } from '../types';

export const normalizePersonName = (name: string): string => name.normalize('NFC').trim().replace(/\s+/g, ' ');
export const personNameKey = (name: string): string => normalizePersonName(name).toLowerCase();

export const collectArchivePeople = (photos: Pick<Photo, 'people' | 'faceTags'>[]): string[] => {
  const names = new Map<string, string>();
  for (const photo of photos) {
    for (const value of [...(photo.people || []), ...(photo.faceTags || []).map(tag => tag.name)]) {
      if (typeof value !== 'string') continue;
      const name = normalizePersonName(value);
      if (name && !names.has(personNameKey(name))) names.set(personNameKey(name), name);
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
};

export const canonicalPersonName = (value: string, existing: string[]): string => {
  const name = normalizePersonName(value);
  return existing.find(candidate => personNameKey(candidate) === personNameKey(name)) || name;
};

// Rename the shared identity without changing face positions, photo data, or unrelated tags.
export const renamePhotoPerson = (photo: Photo, previous: string, next: string): Photo => {
  const oldKey = personNameKey(previous);
  if (!collectArchivePeople([photo]).some(name => personNameKey(name) === oldKey)) return photo;
  const seen = new Set<string>();
  const people = (photo.people || []).map(name => personNameKey(name) === oldKey ? next : name).filter(name => {
    const key = personNameKey(name);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { ...photo, people, faceTags: (photo.faceTags || []).map(tag => personNameKey(tag.name) === oldKey ? { ...tag, name: next } : tag) };
};


export interface PersonNameParts { firstName: string; lastName: string }
export const composePersonName = (firstName: string, lastName: string): string => normalizePersonName(`${firstName} ${lastName}`);
export const getPersonNameParts = (person: Pick<FamilyTreePerson, 'name' | 'firstName' | 'lastName'>): PersonNameParts => {
  if (person.firstName !== undefined && person.lastName !== undefined) return { firstName: normalizePersonName(person.firstName), lastName: normalizePersonName(person.lastName) };
  // Existing archives have a single name. Keep their display names unchanged and let the user correct the split.
  const parts = normalizePersonName(person.name).split(' ');
  return parts.length > 1 ? { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] } : { firstName: parts[0], lastName: '' };
};

export interface MaidenNameInfo { value: string; inheritedValue: string; inherited: boolean; display: string; fatherName?: string }
export const getFamilyMaidenNames = (tree: FamilyTreeData): Map<string, MaidenNameInfo> => {
  const people = new Map(tree.people.map(person => [person.id, person]));
  const parentFamilies = new Map(tree.families.flatMap(family => family.childIds.map(id => [id, family] as const)));
  return new Map(tree.people.map(person => {
    const fathers = (parentFamilies.get(person.id)?.parentIds || []).map(id => people.get(id)).filter(parent => parent?.relationshipGender === 'male');
    // Parent roles are currently expressed by relationship titles. Do not guess from names or parent order.
    const father = fathers.length === 1 ? fathers[0] : undefined;
    const inheritedValue = father ? getPersonNameParts(father).lastName : '';
    const inherited = person.maidenName === undefined;
    const value = inherited ? inheritedValue : normalizePersonName(person.maidenName);
    const display = value && personNameKey(value) !== personNameKey(getPersonNameParts(person).lastName) ? value : '';
    return [person.id, { value, inheritedValue, inherited, display, ...(father ? { fatherName: father.name } : {}) }];
  }));
};


// Include only identities tagged on this photo, never the rest of the family library.
export const getPhotoDescriptionPeople = (photo: Pick<Photo, 'people' | 'faceTags'>, familyPeople: Pick<FamilyTreePerson, 'name' | 'descriptionName'>[] = []): PhotoDescriptionPerson[] => {
  const people = new Map(familyPeople.map(person => [personNameKey(person.name), person]));
  return collectArchivePeople([photo]).map(tagName => {
    const person = people.get(personNameKey(tagName));
    const name = person?.name || tagName;
    return { name, descriptionName: normalizePersonName(person?.descriptionName || '') || name };
  });
};

// Enforce saved wording if the model repeats an archive identity. Match whole
// names in one pass, protecting labels already used and longer overlapping names.
export const applyPhotoDescriptionNames = (description: string, people: PhotoDescriptionPerson[]): string => {
  const references = new Map(people.map(({ name, descriptionName }) => {
    const archiveName = normalizePersonName(name);
    return [personNameKey(archiveName), { name: archiveName, descriptionName: normalizePersonName(descriptionName) || archiveName }] as const;
  }).filter(([, person]) => person.name));
  if (![...references.values()].some(person => person.name !== person.descriptionName)) return description;

  const preferredNames = new Set([...references.values()].map(person => personNameKey(person.descriptionName)));
  const labels = [...new Set([...references.values()].flatMap(person => [person.name, person.descriptionName]))];
  const alternatives = labels.sort((a, b) => b.length - a.length).map(label =>
    label.split(' ').map(part => part.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&')).join('\\s+'),
  ).join('|');
  const boundary = '[\\p{L}\\p{M}\\p{N}_]';
  const pattern = new RegExp('(?<!' + boundary + ')(?:' + alternatives + ')(?!' + boundary + ')', 'giu');
  return description.normalize('NFC').replace(pattern, match => {
    const key = personNameKey(match);
    return preferredNames.has(key) ? match : references.get(key)?.descriptionName || match;
  });
};
