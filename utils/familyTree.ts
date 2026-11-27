import type { FamilyTreeData, FamilyTreeFamily } from '../types';
import { normalizePersonName, personNameKey, composePersonName, getPersonNameParts } from './people';
import { isPartialDate, datesInOrder } from './partialDates';

export type FamilyTreeErrorCode = 'invalidName' | 'invalidTarget' | 'duplicateRelation' | 'parentLimit' | 'spouseLimit' | 'cycle' | 'parentConflict' | 'generationConflict' | 'invalidTree' | 'duplicateName' | 'invalidDate' | 'dateOrder' | 'hasChildren';

const messages: Record<FamilyTreeErrorCode, string> = {
  invalidName: 'Enter a person name.',
  duplicateName: 'This name is already used by another person.',
  invalidDate: 'Enter a valid date at the selected precision.',
  dateOrder: 'The date of death cannot be before the date of birth.',
  hasChildren: 'People with children cannot be deleted.',
  invalidTarget: 'This person or couple is no longer in the family tree.',
  duplicateRelation: 'This person already has that relationship in the tree.',
  parentLimit: 'This person already has two parents.',
  spouseLimit: 'This person already has a spouse in the tree.',
  cycle: 'A person cannot be their own ancestor or marry their ancestor.',
  parentConflict: 'This person already belongs to another pair of parents.',
  generationConflict: 'This relationship would place a person in conflicting generations.',
  invalidTree: 'The saved family tree could not be read. Your existing data has been preserved.',
};

export class FamilyTreeError extends Error {
  constructor(public readonly code: FamilyTreeErrorCode) {
    super(messages[code]);
    this.name = 'FamilyTreeError';
  }
}

export interface FamilyTreeRelation {
  type: 'self' | 'parent' | 'spouse' | 'child';
  personId?: string;
  familyId?: string;
}

export const getPersonLocations = (person: { locations?: string[]; location?: string }): string[] =>
  [...new Set((person.locations ?? (person.location ? [person.location] : [])).map(location => location.trim()).filter(Boolean))];

export const emptyFamilyTree = (): FamilyTreeData => ({ rootId: null, people: [], families: [] });
const fail = (code: FamilyTreeErrorCode): never => { throw new FamilyTreeError(code); };
const makeId = () => globalThis.crypto?.randomUUID?.() || `tree-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// Checking a common generation assignment also detects an ancestor being used as a spouse.
const validateGenerations = (tree: FamilyTreeData) => {
  const edges = new Map(tree.people.map(person => [person.id, [] as { id: string; delta: number }[]]));
  const link = (from: string, to: string, delta: number) => {
    edges.get(from)!.push({ id: to, delta });
    edges.get(to)!.push({ id: from, delta: -delta });
  };
  for (const family of tree.families) {
    if (family.parentIds.length === 2) link(family.parentIds[0], family.parentIds[1], 0);
    for (const childId of family.childIds) for (const parentId of family.parentIds) link(parentId, childId, 1);
  }
  const levels = new Map<string, number>();
  for (const person of tree.people) {
    if (levels.has(person.id)) continue;
    levels.set(person.id, 0);
    const queue = [person.id];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      for (const edge of edges.get(id)!) {
        const level = levels.get(id)! + edge.delta;
        if (levels.has(edge.id)) { if (levels.get(edge.id) !== level) fail('generationConflict'); }
        else { levels.set(edge.id, level); queue.push(edge.id); }
      }
    }
  }
};

const assertRelationships = (tree: FamilyTreeData) => {
  const children = new Set<string>();
  const parents = new Set<string>();
  const descendants = new Map(tree.people.map(person => [person.id, [] as string[]]));
  for (const family of tree.families) {
    for (const id of family.childIds) {
      if (children.has(id)) fail('parentConflict');
      children.add(id);
    }
    for (const id of family.parentIds) {
      if (parents.has(id)) fail('spouseLimit');
      parents.add(id);
      descendants.get(id)!.push(...family.childIds);
      if (family.childIds.includes(id)) fail('cycle');
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) fail('cycle');
    if (done.has(id)) return;
    visiting.add(id);
    for (const child of descendants.get(id)!) visit(child);
    visiting.delete(id); done.add(id);
  };
  for (const person of tree.people) visit(person.id);
  validateGenerations(tree);
};

// Never treat malformed saved data as an empty tree: that could overwrite a real archive.
export const validateFamilyTree = (value: unknown): FamilyTreeData => {
  try {
    if (!value || typeof value !== 'object') fail('invalidTree');
    const tree = value as FamilyTreeData;
    if (!Array.isArray(tree.people) || !Array.isArray(tree.families)) fail('invalidTree');
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const person of tree.people) {
      if (!person || typeof person.id !== 'string' || !person.id || typeof person.name !== 'string' || !normalizePersonName(person.name) || ids.has(person.id) || names.has(personNameKey(person.name))) fail('invalidTree');
      if (person.firstName !== undefined || person.lastName !== undefined) {
        if (typeof person.firstName !== 'string' || !normalizePersonName(person.firstName) || typeof person.lastName !== 'string' || composePersonName(person.firstName, person.lastName) !== normalizePersonName(person.name)) fail('invalidTree');
      }
      if (person.maidenName !== undefined && typeof person.maidenName !== 'string') fail('invalidTree');
      if (person.descriptionName !== undefined && typeof person.descriptionName !== 'string') fail('invalidTree');
      if (person.location !== undefined && typeof person.location !== 'string') fail('invalidTree');
      if (person.locations !== undefined && (!Array.isArray(person.locations) || person.locations.some(location => typeof location !== 'string'))) fail('invalidTree');
      if (person.relationshipGender !== undefined && person.relationshipGender !== 'male' && person.relationshipGender !== 'female') fail('invalidTree');
      if (person.avatarPhotoId !== undefined && (typeof person.avatarPhotoId !== 'string' || !person.avatarPhotoId.trim())) fail('invalidTree');
      if (person.avatarCrop !== undefined) {
        const crop = person.avatarCrop;
        if (!person.avatarPhotoId || !crop || !Number.isFinite(crop.x) || !Number.isFinite(crop.y) || !Number.isFinite(crop.zoom) || crop.x < 0 || crop.x > 100 || crop.y < 0 || crop.y > 100 || crop.zoom < 1 || crop.zoom > 20) fail('invalidTree');
      }
      if ((person.birthDate !== undefined && !isPartialDate(person.birthDate)) || (person.deathDate !== undefined && !isPartialDate(person.deathDate)) || !datesInOrder(person.birthDate, person.deathDate)) fail('invalidTree');
      ids.add(person.id); names.add(personNameKey(person.name));
    }
    // Deleting the starting person asks the user to choose themselves again, preserving relatives.
    if (tree.rootId !== null && (typeof tree.rootId !== 'string' || !ids.has(tree.rootId))) fail('invalidTree');
    if (!tree.people.length && (tree.rootId !== null || tree.families.length !== 0)) fail('invalidTree');
    const familyIds = new Set<string>();
    for (const family of tree.families) {
      if (!family || typeof family.id !== 'string' || !family.id || familyIds.has(family.id) || !Array.isArray(family.parentIds) || !Array.isArray(family.childIds) || family.parentIds.length < 1 || family.parentIds.length > 2) fail('invalidTree');
      familyIds.add(family.id);
      const members = [...family.parentIds, ...family.childIds];
      if (new Set(members).size !== members.length || members.some(id => typeof id !== 'string' || !ids.has(id))) fail('invalidTree');
    }
    assertRelationships(tree);
    return { rootId: tree.rootId, people: tree.people.map(person => {
      const normalized = { ...person, name: normalizePersonName(person.name), ...(person.firstName !== undefined ? getPersonNameParts(person) : {}), ...(person.maidenName !== undefined ? { maidenName: normalizePersonName(person.maidenName) } : {}) };
      delete normalized.descriptionName;
      if (person.descriptionName && normalizePersonName(person.descriptionName)) normalized.descriptionName = normalizePersonName(person.descriptionName);
      delete normalized.location;
      delete normalized.locations;
      const locations = getPersonLocations(person);
      if (locations.length) normalized.locations = locations;
      return normalized;
    }), families: tree.families.map(family => ({ id: family.id, parentIds: [...family.parentIds], childIds: [...family.childIds] })) };
  } catch { return fail('invalidTree'); }
};

export const addFamilyMember = (current: FamilyTreeData, value: string, relation: FamilyTreeRelation): FamilyTreeData => {
  const name = normalizePersonName(value);
  if (!name) fail('invalidName');
  const tree = validateFamilyTree(current);
  if (relation.type === 'self' && tree.rootId !== null) fail('duplicateRelation');
  let person = tree.people.find(candidate => personNameKey(candidate.name) === personNameKey(name));
  if (!person) { person = { id: makeId(), name, ...getPersonNameParts({ name }) }; tree.people.push(person); }
  if (relation.type === 'self') { tree.rootId = person.id; return tree; }
  if (!tree.rootId || (relation.personId && !tree.people.some(candidate => candidate.id === relation.personId))) fail('invalidTarget');
  const targetId = relation.personId;
  const createFamily = (parentIds: string[], childIds: string[]): FamilyTreeFamily => {
    const family = { id: makeId(), parentIds, childIds }; tree.families.push(family); return family;
  };
  if (relation.type === 'parent') {
    if (!targetId) fail('invalidTarget');
    if (person.id === targetId) fail('cycle');
    const existing = tree.families.find(family => family.childIds.includes(targetId));
    if (existing?.parentIds.includes(person.id)) fail('duplicateRelation');
    if (existing && existing.parentIds.length >= 2) fail('parentLimit');
    if (existing) existing.parentIds.push(person.id);
    else {
      // Reusing a known parent also reuses their existing couple and siblings.
      const parentFamily = tree.families.find(family => family.parentIds.includes(person!.id));
      if (parentFamily) parentFamily.childIds.push(targetId);
      else createFamily([person.id], [targetId]);
    }
  } else if (relation.type === 'spouse') {
    if (!targetId) fail('invalidTarget');
    if (person.id === targetId) fail('cycle');
    const family = tree.families.find(candidate => candidate.parentIds.includes(targetId));
    if (family?.parentIds.includes(person.id)) fail('duplicateRelation');
    if (family && family.parentIds.length >= 2) fail('spouseLimit');
    const spouseFamily = tree.families.find(candidate => candidate.parentIds.includes(person!.id));
    if (spouseFamily) {
      if (spouseFamily.parentIds.length >= 2 || family) fail('spouseLimit');
      spouseFamily.parentIds.push(targetId);
    } else if (family) family.parentIds.push(person.id);
    else createFamily([targetId, person.id], []);
  } else if (relation.type === 'child') {
    let family = relation.familyId ? tree.families.find(candidate => candidate.id === relation.familyId) : tree.families.find(candidate => candidate.parentIds.includes(targetId!));
    if (relation.familyId && !family) fail('invalidTarget');
    if (!family) { if (!targetId) fail('invalidTarget'); family = createFamily([targetId], []); }
    if (family.parentIds.includes(person.id)) fail('cycle');
    if (family.childIds.includes(person.id)) fail('duplicateRelation');
    if (tree.families.some(candidate => candidate.childIds.includes(person!.id))) fail('parentConflict');
    family.childIds.push(person.id);
  } else fail('invalidTarget');
  assertRelationships(tree);
  return tree;
};

export interface FamilyTreePersonDetails {
  name?: string; // Backwards-compatible full-name updates.
  firstName?: string;
  lastName?: string;
  maidenName?: string;
  descriptionName?: string;
  locations?: string[];
  location?: string; // Backwards-compatible single-location updates.
  birthDate?: string;
  deathDate?: string;
  relationshipGender?: 'male' | 'female';
}

export const updateFamilyMember = (current: FamilyTreeData, personId: string, details: FamilyTreePersonDetails, knownPeople: string[] = []): FamilyTreeData => {
  const tree = validateFamilyTree(current);
  const person = tree.people.find(item => item.id === personId);
  if (!person) fail('invalidTarget');
  let parts = getPersonNameParts(person);
  if (details.firstName !== undefined || details.lastName !== undefined) {
    if (typeof details.firstName !== 'string' || typeof details.lastName !== 'string') fail('invalidName');
    parts = { firstName: normalizePersonName(details.firstName), lastName: normalizePersonName(details.lastName) };
  } else if (details.name !== undefined) {
    if (typeof details.name !== 'string') fail('invalidName');
    const fullName = normalizePersonName(details.name);
    if (fullName !== person.name) parts = getPersonNameParts({ name: fullName });
  }
  if (!parts.firstName) fail('invalidName');
  const name = composePersonName(parts.firstName, parts.lastName);
  if (details.maidenName !== undefined && typeof details.maidenName !== 'string') fail('invalidName');
  if (details.descriptionName !== undefined && typeof details.descriptionName !== 'string') fail('invalidName');
  if (details.location !== undefined && typeof details.location !== 'string') fail('invalidTree');
  if (details.locations !== undefined && (!Array.isArray(details.locations) || details.locations.some(location => typeof location !== 'string'))) fail('invalidTree');
  const key = personNameKey(name);
  if (tree.people.some(item => item.id !== personId && personNameKey(item.name) === key) || (key !== personNameKey(person.name) && knownPeople.some(item => personNameKey(item) === key))) fail('duplicateName');
  for (const date of [details.birthDate, details.deathDate]) if (date && !isPartialDate(date)) fail('invalidDate');
  if (!datesInOrder(details.birthDate, details.deathDate)) fail('dateOrder');
  if (details.relationshipGender !== undefined && details.relationshipGender !== 'male' && details.relationshipGender !== 'female') fail('invalidTree');
  person.name = name;
  person.firstName = parts.firstName; person.lastName = parts.lastName;
  if ('maidenName' in details) {
    delete person.maidenName;
    if (details.maidenName !== undefined) person.maidenName = normalizePersonName(details.maidenName);
  }
  if ('descriptionName' in details) {
    delete person.descriptionName;
    if (details.descriptionName && normalizePersonName(details.descriptionName)) person.descriptionName = normalizePersonName(details.descriptionName);
  }
  if ('locations' in details || 'location' in details) {
    delete person.location;
    delete person.locations;
    const locations = getPersonLocations(details);
    if (locations.length) person.locations = locations;
  }
  delete person.birthDate; delete person.deathDate; delete person.relationshipGender;
  if (details.birthDate) person.birthDate = details.birthDate;
  if (details.deathDate) person.deathDate = details.deathDate;
  if (details.relationshipGender) person.relationshipGender = details.relationshipGender;
  return tree;
};

export const canDeleteFamilyMember = (tree: FamilyTreeData, personId: string): boolean =>
  tree.people.some(person => person.id === personId) && !tree.families.some(family => family.parentIds.includes(personId) && family.childIds.length > 0);

export const removeFamilyMember = (current: FamilyTreeData, personId: string): FamilyTreeData => {
  const tree = validateFamilyTree(current);
  if (!tree.people.some(person => person.id === personId)) fail('invalidTarget');
  if (!canDeleteFamilyMember(tree, personId)) fail('hasChildren');
  tree.people = tree.people.filter(person => person.id !== personId);
  tree.families = tree.families.map(family => ({ ...family, parentIds: family.parentIds.filter(id => id !== personId), childIds: family.childIds.filter(id => id !== personId) }))
    .filter(family => family.parentIds.length > 0 && (family.parentIds.length === 2 || family.childIds.length > 0));
  if (tree.rootId === personId) tree.rootId = null;
  return validateFamilyTree(tree);
};
