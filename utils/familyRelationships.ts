import type { FamilyTreeData, FamilyTreePerson, Language } from '../types';

type Gender = FamilyTreePerson['relationshipGender'];
type Lineage = { up: number; down: number };
type Words = readonly [string, string, string]; // Neutral, male, female.
type Edge = { id: string; kind: 'parent' | 'child' | 'spouse' };
const choose = (words: Words, gender: Gender) => words[gender === 'male' ? 1 : gender === 'female' ? 2 : 0];
const upper = (word: string) => word[0].toLocaleUpperCase() + word.slice(1);
const lower = (word: string) => word[0].toLocaleLowerCase() + word.slice(1);
const ordinal = (number: number) => `${number}${number % 100 >= 11 && number % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] || 'th')}`;

function lineageTitle({ up, down }: Lineage, gender: Gender, language: Language, genitive = false): string {
  if (language === 'en') {
    let result: string;
    if (!up && !down) return 'You';
    if (!up || !down) {
      const ancestor = down === 0;
      const generations = up || down;
      const words: Words = ancestor
        ? generations === 1 ? ['parent', 'father', 'mother'] : ['grandparent', 'grandfather', 'grandmother']
        : generations === 1 ? ['child', 'son', 'daughter'] : ['grandchild', 'grandson', 'granddaughter'];
      const greats = generations - 2;
      result = (greats > 0 ? greats === 1 ? 'great-' : `${greats}× great-` : '') + choose(words, gender);
    } else if (up === 1 && down === 1) result = choose(['sibling', 'brother', 'sister'], gender);
    else if (up === 1 || down === 1) {
      const aunt = down === 1;
      const greats = (aunt ? up : down) - 2;
      const prefix = greats > 0 ? greats === 1 ? 'great-' : `${greats}× great-` : '';
      const words: Words = aunt ? ['aunt / uncle', 'uncle', 'aunt'] : ['niece / nephew', 'nephew', 'niece'];
      result = choose(words, gender).split(' / ').map(word => prefix + word).join(' / ');
    } else {
      const degree = Math.min(up, down) - 1;
      const removed = Math.abs(up - down);
      result = degree === 1 ? 'cousin' : `${ordinal(degree)} cousin`;
      if (removed) result += ` ${removed === 1 ? 'once' : removed === 2 ? 'twice' : `${removed} times`} removed`;
    }
    return upper(result);
  }

  let result: string;
  if (!up && !down) return genitive ? 'vás' : 'Vy';
  if (!up || !down) {
    const ancestor = down === 0;
    const generations = up || down;
    if (generations === 1) result = choose(ancestor
      ? genitive ? ['rodiča', 'otca', 'matky'] : ['rodič', 'otec', 'matka']
      : genitive ? ['dieťaťa', 'syna', 'dcéry'] : ['dieťa', 'syn', 'dcéra'], gender);
    else if (generations <= 5) {
      const base = choose(ancestor
        ? genitive ? ['starého rodiča', 'starého otca', 'starej mamy'] : ['starý rodič', 'starý otec', 'stará mama']
        : genitive ? ['vnúčaťa', 'vnuka', 'vnučky'] : ['vnúča', 'vnuk', 'vnučka'], gender);
      result = 'pra'.repeat(generations - 2) + base;
    } else result = `${ancestor ? genitive ? 'predka' : 'predok' : genitive ? 'potomka' : 'potomok'} v ${generations}. generácii`;
  } else if (up === 1 && down === 1) result = choose(genitive ? ['súrodenca', 'brata', 'sestry'] : ['súrodenec', 'brat', 'sestra'], gender);
  else if (up === 1 || down === 1) {
    const aunt = down === 1;
    const greats = (aunt ? up : down) - 2;
    const base = choose(aunt
      ? genitive ? ['tety / strýka', 'strýka', 'tety'] : ['teta / strýko', 'strýko', 'teta']
      : genitive ? ['synovca / netere', 'synovca', 'netere'] : ['synovec / neter', 'synovec', 'neter'], gender);
    result = greats <= 3 ? base.split(' / ').map(word => 'pra'.repeat(greats) + word).join(' / ') : `${base} (${greats}× pra)`;
  } else {
    const degree = Math.min(up, down) - 1;
    const removed = Math.abs(up - down);
    result = choose(genitive ? ['bratranca / sesternice', 'bratranca', 'sesternice'] : ['bratranec / sesternica', 'bratranec', 'sesternica'], gender);
    if (degree > 1) result += ` (${degree}. koleno)`;
    if (removed) result += ` (rozdiel generácií: ${removed})`;
  }
  return genitive ? result : upper(result);
}

function spouseTitle(gender: Gender, language: Language, genitive = false) {
  if (language === 'en') return choose(['Spouse', 'Husband', 'Wife'], gender);
  return choose(genitive ? ['partnera / partnerky', 'manžela', 'manželky'] : ['Manžel / manželka', 'Manžel', 'Manželka'], gender);
}
function inLawTitle(kind: 'parent' | 'sibling' | 'child', gender: Gender, language: Language) {
  const english: Record<typeof kind, Words> = { parent: ['Parent-in-law', 'Father-in-law', 'Mother-in-law'], sibling: ['Sibling-in-law', 'Brother-in-law', 'Sister-in-law'], child: ['Child-in-law', 'Son-in-law', 'Daughter-in-law'] };
  const slovak: Record<typeof kind, Words> = { parent: ['Svokor / svokra', 'Svokor', 'Svokra'], sibling: ['Švagor / švagriná', 'Švagor', 'Švagriná'], child: ['Zať / nevesta', 'Zať', 'Nevesta'] };
  return choose((language === 'en' ? english : slovak)[kind], gender);
}
function throughSpouse(relation: Lineage, person: FamilyTreePerson, spouse: FamilyTreePerson, language: Language) {
  if (relation.up === 1 && relation.down === 0) return inLawTitle('parent', person.relationshipGender, language);
  if (relation.up === 1 && relation.down === 1) return inLawTitle('sibling', person.relationshipGender, language);
  if (relation.up === 0 && relation.down === 1) return language === 'en' ? choose(['Stepchild', 'Stepson', 'Stepdaughter'], person.relationshipGender) : choose(['Nevlastné dieťa', 'Nevlastný syn', 'Nevlastná dcéra'], person.relationshipGender);
  const title = lineageTitle(relation, person.relationshipGender, language);
  return language === 'en' ? `${spouseTitle(spouse.relationshipGender, language)}’s ${lower(title)}` : `${title} ${spouseTitle(spouse.relationshipGender, language, true)}`;
}
function spouseOfRelative(relation: Lineage, person: FamilyTreePerson, relative: FamilyTreePerson, language: Language) {
  if (relation.up === 0 && relation.down === 1) return inLawTitle('child', person.relationshipGender, language);
  if (relation.up === 1 && relation.down === 1) return inLawTitle('sibling', person.relationshipGender, language);
  if (relation.up === 1 && relation.down === 0) return language === 'en' ? choose(['Stepparent', 'Stepfather', 'Stepmother'], person.relationshipGender) : choose(['Nevlastný rodič', 'Nevlastný otec', 'Nevlastná matka'], person.relationshipGender);
  return language === 'en'
    ? `${lineageTitle(relation, relative.relationshipGender, language)}’s ${lower(spouseTitle(person.relationshipGender, language))}`
    : `${spouseTitle(person.relationshipGender, language)} ${lineageTitle(relation, relative.relationshipGender, language, true)}`;
}

/** Derive titles from the starting person, never from names or the currently selected card. */
export function getFamilyRelationshipLabels(tree: FamilyTreeData, language: Language): Map<string, string> {
  const people = new Map(tree.people.map(person => [person.id, person]));
  const unknown = language === 'en' ? 'Not connected to you' : 'Bez spojenia s vami';
  const labels = new Map(tree.people.map(person => [person.id, unknown]));
  if (!tree.rootId || !people.has(tree.rootId)) return labels;
  const parents = new Map(tree.people.map(person => [person.id, new Set<string>()]));
  const children = new Map(tree.people.map(person => [person.id, new Set<string>()]));
  const spouses = new Map(tree.people.map(person => [person.id, new Set<string>()]));
  for (const family of tree.families) {
    const parentIds = family.parentIds.filter(id => people.has(id));
    for (const parentId of parentIds) {
      for (const childId of family.childIds) if (people.has(childId)) { parents.get(childId)!.add(parentId); children.get(parentId)!.add(childId); }
      for (const spouseId of parentIds) if (spouseId !== parentId) spouses.get(parentId)!.add(spouseId);
    }
  }
  const ancestorCache = new Map<string, Map<string, number>>();
  const ancestorsOf = (id: string) => {
    if (ancestorCache.has(id)) return ancestorCache.get(id)!;
    const ancestors = new Map([[id, 0]]);
    const queue = [id];
    for (let index = 0; index < queue.length; index++) for (const parentId of parents.get(queue[index])!) {
      if (ancestors.has(parentId)) continue;
      ancestors.set(parentId, ancestors.get(queue[index])! + 1); queue.push(parentId);
    }
    ancestorCache.set(id, ancestors); return ancestors;
  };
  const lineageCache = new Map<string, Map<string, Lineage>>();
  const lineageFrom = (sourceId: string) => {
    if (lineageCache.has(sourceId)) return lineageCache.get(sourceId)!;
    const sourceAncestors = ancestorsOf(sourceId);
    const result = new Map<string, Lineage>();
    for (const person of tree.people) {
      const targetAncestors = ancestorsOf(person.id);
      if (sourceAncestors.has(person.id)) { result.set(person.id, { up: sourceAncestors.get(person.id)!, down: 0 }); continue; }
      if (targetAncestors.has(sourceId)) { result.set(person.id, { up: 0, down: targetAncestors.get(sourceId)! }); continue; }
      let closest: Lineage | undefined;
      for (const [ancestorId, up] of sourceAncestors) {
        const down = targetAncestors.get(ancestorId);
        if (down !== undefined && (!closest || up + down < closest.up + closest.down)) closest = { up, down };
      }
      if (closest) result.set(person.id, closest);
    }
    lineageCache.set(sourceId, result); return result;
  };

  // Unusual, distant relationships by marriage retain an exact readable path.
  let paths: Map<string, Edge[]> | undefined;
  const pathTitle = (personId: string) => {
    if (!paths) {
      paths = new Map([[tree.rootId!, []]]);
      const queue = [tree.rootId!];
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index];
        const edges: Edge[] = [
          ...[...parents.get(id)!].map(id => ({ id, kind: 'parent' as const })),
          ...[...children.get(id)!].map(id => ({ id, kind: 'child' as const })),
          ...[...spouses.get(id)!].map(id => ({ id, kind: 'spouse' as const })),
        ];
        for (const edge of edges) if (!paths.has(edge.id)) { paths.set(edge.id, [...paths.get(id)!, edge]); queue.push(edge.id); }
      }
    }
    const path = paths.get(personId);
    if (!path?.length) return unknown;
    const parts: { title: string; genitive: string }[] = [];
    for (let index = 0; index < path.length;) {
      const edge = path[index];
      if (edge.kind === 'spouse') {
        parts.push({ title: spouseTitle(people.get(edge.id)!.relationshipGender, language), genitive: spouseTitle(people.get(edge.id)!.relationshipGender, language, true) }); index++;
      } else {
        let up = 0, down = 0, target = edge.id;
        while (index < path.length && path[index].kind !== 'spouse' && !(down && path[index].kind === 'parent')) {
          if (path[index].kind === 'parent') up++; else down++;
          target = path[index++].id;
        }
        const gender = people.get(target)!.relationshipGender;
        parts.push({ title: lineageTitle({ up, down }, gender, language), genitive: lineageTitle({ up, down }, gender, language, true) });
      }
    }
    return language === 'en' ? parts.map((part, index) => index ? lower(part.title) : part.title).join('’s ')
      : [parts[parts.length - 1].title, ...parts.slice(0, -1).reverse().map(part => part.genitive)].join(' ');
  };

  const rootRelations = lineageFrom(tree.rootId);
  const rootSpouses = [...spouses.get(tree.rootId)!];
  for (const person of tree.people) {
    let title: string | undefined;
    if (person.id === tree.rootId) title = language === 'en' ? 'You' : 'Vy';
    else if (rootSpouses.includes(person.id)) title = spouseTitle(person.relationshipGender, language);
    else if (rootRelations.has(person.id)) title = lineageTitle(rootRelations.get(person.id)!, person.relationshipGender, language);
    if (!title) for (const spouseId of rootSpouses) {
      const relation = lineageFrom(spouseId).get(person.id);
      if (relation) { title = throughSpouse(relation, person, people.get(spouseId)!, language); break; }
    }
    if (!title) for (const spouseId of spouses.get(person.id)!) {
      const relation = rootRelations.get(spouseId);
      if (relation) { title = spouseOfRelative(relation, person, people.get(spouseId)!, language); break; }
    }
    if (!title) for (const sourceSpouseId of rootSpouses) {
      for (const targetSpouseId of spouses.get(person.id)!) {
        const relation = lineageFrom(sourceSpouseId).get(targetSpouseId);
        if (!relation) continue;
        const sourceSpouse = people.get(sourceSpouseId)!;
        const relative = people.get(targetSpouseId)!;
        title = language === 'en'
          ? `${throughSpouse(relation, relative, sourceSpouse, language)}’s ${lower(spouseTitle(person.relationshipGender, language))}`
          : `${spouseTitle(person.relationshipGender, language)} ${lineageTitle(relation, relative.relationshipGender, language, true)} ${spouseTitle(sourceSpouse.relationshipGender, language, true)}`;
        break;
      }
      if (title) break;
    }
    labels.set(person.id, title || pathTitle(person.id));
  }
  return labels;
}
