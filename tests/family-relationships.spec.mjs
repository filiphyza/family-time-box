import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(fs.readFileSync(new URL('../utils/familyRelationships.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { getFamilyRelationshipLabels } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function fixture() {
  const genders = {
    spouse: 'female', father: 'male', mother: 'female', grandfather: 'male', grandmother: 'female', maternalGrandfather: 'male', maternalGrandmother: 'female',
    greatGrandfather: 'male', greatGrandmother: 'female', secondGreatGrandfather: 'male', sister: 'female', brotherInLaw: 'male', niece: 'female',
    child: 'male', childSpouse: 'female', grandchild: 'female', grandchildSpouse: 'male', greatGrandchild: 'male', uncle: 'male', auntByMarriage: 'female',
    cousin: 'female', cousinSpouse: 'male', removedCousin: 'female', secondCousin: 'male', greatUncle: 'male',
    fatherInLaw: 'male', motherInLaw: 'female', brotherOfSpouse: 'male', brotherPartner: 'female', spouseGrandfather: 'male', childSpouseParent: 'male',
  };
  const families = [
    { id: 'root-couple', parentIds: ['me', 'spouse'], childIds: ['child'] },
    { id: 'parents', parentIds: ['father', 'mother'], childIds: ['me', 'sister'] },
    { id: 'grandparents', parentIds: ['grandfather', 'grandmother'], childIds: ['father', 'uncle'] },
    { id: 'maternal-grandparents', parentIds: ['maternalGrandfather', 'maternalGrandmother'], childIds: ['mother'] },
    { id: 'great-grandparents', parentIds: ['greatGrandfather', 'greatGrandmother'], childIds: ['grandfather', 'greatUncle'] },
    { id: 'older-ancestors', parentIds: ['secondGreatGrandfather'], childIds: ['greatGrandfather'] },
    { id: 'sister-family', parentIds: ['sister', 'brotherInLaw'], childIds: ['niece'] },
    { id: 'children-family', parentIds: ['child', 'childSpouse'], childIds: ['grandchild'] },
    { id: 'grandchildren-family', parentIds: ['grandchild', 'grandchildSpouse'], childIds: ['greatGrandchild'] },
    { id: 'uncle-family', parentIds: ['uncle', 'auntByMarriage'], childIds: ['cousin'] },
    { id: 'cousin-family', parentIds: ['cousin', 'cousinSpouse'], childIds: ['removedCousin'] },
    { id: 'great-uncle-family', parentIds: ['greatUncle'], childIds: ['parentCousin'] },
    { id: 'second-cousin-family', parentIds: ['parentCousin'], childIds: ['secondCousin'] },
    { id: 'spouse-family', parentIds: ['fatherInLaw', 'motherInLaw'], childIds: ['spouse', 'brotherOfSpouse'] },
    { id: 'spouse-grandparents', parentIds: ['spouseGrandfather'], childIds: ['fatherInLaw'] },
    { id: 'brother-of-spouse-family', parentIds: ['brotherOfSpouse', 'brotherPartner'], childIds: [] },
    { id: 'child-spouse-family', parentIds: ['childSpouseParent'], childIds: ['childSpouse'] },
  ];
  const ids = new Set(['me', 'unlinked']);
  for (const family of families) for (const id of [...family.parentIds, ...family.childIds]) ids.add(id);
  return { rootId: 'me', people: [...ids].map(id => ({ id, name: id, ...(genders[id] ? { relationshipGender: genders[id] } : {}) })), families };
}

test('titles identify ancestors and descendants across generations', () => {
  const tree = fixture(); const labels = getFamilyRelationshipLabels(tree, 'en');
  for (const [id, title] of Object.entries({ me: 'You', spouse: 'Wife', father: 'Father', mother: 'Mother', grandfather: 'Grandfather', grandmother: 'Grandmother', maternalGrandfather: 'Grandfather', maternalGrandmother: 'Grandmother', greatGrandfather: 'Great-grandfather', secondGreatGrandfather: '2× great-grandfather', child: 'Son', grandchild: 'Granddaughter', greatGrandchild: 'Great-grandson' })) expect(labels.get(id), id).toBe(title);
});

test('shared ancestors distinguish siblings, nieces, cousins and removed cousins', () => {
  const labels = getFamilyRelationshipLabels(fixture(), 'en');
  for (const [id, title] of Object.entries({ sister: 'Sister', niece: 'Niece', uncle: 'Uncle', greatUncle: 'Great-uncle', cousin: 'Cousin', removedCousin: 'Cousin once removed', parentCousin: 'Cousin once removed', secondCousin: '2nd cousin' })) expect(labels.get(id), id).toBe(title);
  const tree = fixture();
  tree.people.push({ id: 'moreRemoved', name: 'Distant cousin' });
  tree.families.push({ id: 'one-more-generation', parentIds: ['removedCousin'], childIds: ['moreRemoved'] });
  expect(getFamilyRelationshipLabels(tree, 'en').get('moreRemoved')).toBe('Cousin twice removed');
});

test('relatives by marriage have precise titles and distant connections retain a readable path', () => {
  const labels = getFamilyRelationshipLabels(fixture(), 'en');
  for (const [id, title] of Object.entries({ fatherInLaw: 'Father-in-law', motherInLaw: 'Mother-in-law', brotherOfSpouse: 'Brother-in-law', brotherInLaw: 'Brother-in-law', childSpouse: 'Daughter-in-law', spouseGrandfather: 'Wife’s grandfather', cousinSpouse: 'Cousin’s husband', auntByMarriage: 'Uncle’s wife', grandchildSpouse: 'Granddaughter’s husband', childSpouseParent: 'Son’s wife’s father', brotherPartner: 'Brother-in-law’s wife' })) expect(labels.get(id), id).toBe(title);
});

test('unspecified titles are neutral and names never determine them', () => {
  const tree = fixture();
  for (const person of tree.people) { delete person.relationshipGender; person.name = 'Name that suggests nothing'; }
  const labels = getFamilyRelationshipLabels(tree, 'en');
  for (const [id, title] of Object.entries({ spouse: 'Spouse', father: 'Parent', grandfather: 'Grandparent', sister: 'Sibling', child: 'Child', uncle: 'Aunt / uncle', niece: 'Niece / nephew', cousin: 'Cousin', fatherInLaw: 'Parent-in-law' })) expect(labels.get(id), id).toBe(title);
});

test('Slovak titles include gendered and neutral relationships', () => {
  const tree = fixture(); const labels = getFamilyRelationshipLabels(tree, 'sk');
  for (const [id, title] of Object.entries({ me: 'Vy', father: 'Otec', mother: 'Matka', grandfather: 'Starý otec', grandmother: 'Stará mama', greatGrandfather: 'Prastarý otec', secondGreatGrandfather: 'Praprastarý otec', child: 'Syn', grandchild: 'Vnučka', sister: 'Sestra', cousin: 'Sesternica', secondCousin: 'Bratranec (2. koleno)', fatherInLaw: 'Svokor', childSpouse: 'Nevesta', cousinSpouse: 'Manžel sesternice', childSpouseParent: 'Otec manželky syna' })) expect(labels.get(id), id).toBe(title);
  delete tree.people.find(person => person.id === 'grandfather').relationshipGender;
  expect(getFamilyRelationshipLabels(tree, 'sk').get('grandfather')).toBe('Starý rodič');
});

test('changing the starting person recomputes relationships and keeps the tree immutable', () => {
  const tree = fixture(); const before = JSON.stringify(tree);
  getFamilyRelationshipLabels(tree, 'en'); expect(JSON.stringify(tree)).toBe(before);
  tree.rootId = 'child'; const labels = getFamilyRelationshipLabels(tree, 'en');
  expect(labels.get('child')).toBe('You'); expect(labels.get('me')).toBe('Parent'); expect(labels.get('spouse')).toBe('Mother');
  expect(labels.get('sister')).toBe('Aunt'); expect(labels.get('grandfather')).toBe('Great-grandfather'); expect(labels.get('cousin')).toBe('Cousin once removed');
  const reordered = { ...tree, people: [...tree.people].reverse(), families: [...tree.families].reverse() };
  expect([...getFamilyRelationshipLabels(reordered, 'en')].sort()).toEqual([...labels].sort());
});

test('disconnected people and a missing starting person are explicit', () => {
  const tree = fixture();
  expect(getFamilyRelationshipLabels(tree, 'en').get('unlinked')).toBe('Not connected to you');
  expect(getFamilyRelationshipLabels({ ...tree, rootId: null }, 'en').get('father')).toBe('Not connected to you');
  expect(getFamilyRelationshipLabels({ rootId: null, people: [], families: [] }, 'en').size).toBe(0);
});

async function seed(page) {
  await page.goto('/');
  const tree = fixture();
  tree.people.find(person => person.id === 'father').name = 'Robert';
  delete tree.people.find(person => person.id === 'father').relationshipGender;
  tree.people.find(person => person.id === 'father').birthDate = '1960';
  tree.people.find(person => person.id === 'removedCousin').name = 'Katarína Alexandra Nováková';
  await page.evaluate(async tree => {
    const { storageService } = await import('/services/storageService.ts');
    await storageService.saveFamilyTree(tree);
  }, tree);
  await page.reload(); await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  await expect(page.getByTestId('family-tree-canvas')).toBeVisible();
  return tree;
}

test('cards and drawer show relationships to me even after selecting another person', async ({ page }) => {
  await seed(page);
  const granddad = page.getByRole('button', { name: 'Select grandfather', exact: true });
  const cousin = page.getByRole('button', { name: 'Select cousin', exact: true });
  await expect(granddad.locator('.ft-node-role')).toHaveText('Grandfather');
  await expect(cousin.locator('.ft-node-role')).toHaveText('Cousin');
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click();
  await granddad.click();
  await expect(page.locator('.ft-detail-top .ft-node-role')).toHaveText('Grandfather');
  await expect(cousin.locator('.ft-node-role')).toHaveText('Cousin');
  await expect(granddad).toHaveAttribute('aria-description', 'Grandfather');
  const longCard = page.getByRole('button', { name: 'Select Katarína Alexandra Nováková', exact: true });
  await expect(longCard.locator('.ft-node-role')).toHaveAttribute('title', 'Cousin once removed');
  const bounds = await longCard.boundingBox();
  const lastLine = await longCard.locator('.ft-photo-count').boundingBox();
  expect(lastLine.y + lastLine.height).toBeLessThan(bounds.y + bounds.height);
  await page.reload(); await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  await expect(granddad.locator('.ft-node-role')).toHaveText('Grandfather');
});

test('title preferences save from the drawer and can be reset without changing dates', async ({ page }) => {
  await seed(page);
  const parent = page.getByRole('button', { name: 'Select Robert', exact: true });
  await expect(parent.locator('.ft-node-role')).toHaveText('Parent');
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click(); await parent.click();
  const drawer = page.locator('#family-tree-details');
  await drawer.getByRole('button', { name: 'Edit details', exact: true }).click();
  await drawer.getByRole('combobox', { name: 'Relationship titles', exact: true }).selectOption('male');
  await drawer.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(parent.locator('.ft-node-role')).toHaveText('Father');
  await expect(drawer.locator('.ft-detail-top .ft-node-role')).toHaveText('Father');
  await page.reload(); await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  await expect(parent.locator('.ft-node-role')).toHaveText('Father');
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click(); await parent.click();
  await drawer.getByRole('button', { name: 'Edit details', exact: true }).click();
  await expect(drawer.getByRole('combobox', { name: 'Relationship titles', exact: true })).toHaveValue('male');
  await drawer.getByRole('combobox', { name: 'Relationship titles', exact: true }).selectOption('');
  await drawer.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(parent.locator('.ft-node-role')).toHaveText('Parent');
  const person = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    return (await storageService.loadFamilyTree()).people.find(person => person.id === 'father');
  });
  expect(person.birthDate).toBe('1960'); expect(person).not.toHaveProperty('relationshipGender');
});

test('linking an existing person updates their title immediately and labels localize to Slovak', async ({ page }) => {
  await seed(page);
  const unlinked = page.getByRole('button', { name: 'Select unlinked', exact: true });
  await expect(unlinked.locator('.ft-node-role')).toHaveText('Not connected to you');
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click();
  await page.getByRole('button', { name: 'Select spouseGrandfather', exact: true }).click();
  await page.getByRole('button', { name: 'Add parent', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill('unlinked');
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(unlinked.locator('.ft-node-role')).toHaveText('Wife’s great-grandparent');
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ ...storageService.getSettings(), language: 'sk' });
  });
  await page.reload(); await page.getByRole('button', { name: 'Rodokmeň', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Vybrať grandfather', exact: true }).locator('.ft-node-role')).toHaveText('Starý otec');
  await expect(page.getByRole('button', { name: 'Vybrať cousin', exact: true }).locator('.ft-node-role')).toHaveText('Sesternica');
});
