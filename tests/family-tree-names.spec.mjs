import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(fs.readFileSync(new URL('../utils/people.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { getPersonNameParts, composePersonName, getFamilyMaidenNames } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function namesTree() {
  return {
    rootId: 'anna', people: [
      { id: 'anna', name: 'Anna Smith', birthDate: '1984-02', relationshipGender: 'female', avatarPhotoId: 'portrait' },
      { id: 'dad', name: 'John Jones', firstName: 'John', lastName: 'Jones', relationshipGender: 'male' },
      { id: 'mum', name: 'Mary Brown', firstName: 'Mary', lastName: 'Brown', relationshipGender: 'female' },
      { id: 'ben', name: 'Ben Jones', firstName: 'Ben', lastName: 'Jones', relationshipGender: 'male' },
      { id: 'spouse', name: 'Pat Smith', relationshipGender: 'male' },
    ], families: [
      { id: 'parents', parentIds: ['mum', 'dad'], childIds: ['anna', 'ben'] },
      { id: 'couple', parentIds: ['anna', 'spouse'], childIds: [] },
    ],
  };
}

test('existing names split without changing their display, and explicit compound surnames stay intact', () => {
  expect(getPersonNameParts({ name: '  Anna   Smith ' })).toEqual({ firstName: 'Anna', lastName: 'Smith' });
  expect(getPersonNameParts({ name: 'Anna' })).toEqual({ firstName: 'Anna', lastName: '' });
  expect(getPersonNameParts({ name: 'María José de la Cruz', firstName: 'María José', lastName: 'de la Cruz' })).toEqual({ firstName: 'María José', lastName: 'de la Cruz' });
  expect(composePersonName('  Anne   Marie ', ' de   Silva ')).toBe('Anne Marie de Silva');
});

test('maiden names follow the father, while custom and explicitly blank values override inheritance', () => {
  const tree = namesTree(); const original = JSON.stringify(tree);
  const names = getFamilyMaidenNames(tree);
  expect(names.get('anna')).toMatchObject({ value: 'Jones', inheritedValue: 'Jones', inherited: true, display: 'Jones', fatherName: 'John Jones' });
  expect(names.get('ben').display).toBe(''); expect(JSON.stringify(tree)).toBe(original);
  tree.people[0].maidenName = '  van   Dijk ';
  tree.people[1].name = 'John de la Cruz'; tree.people[1].lastName = 'de la Cruz';
  expect(getFamilyMaidenNames(tree).get('anna')).toMatchObject({ value: 'van Dijk', inherited: false, inheritedValue: 'de la Cruz' });
  tree.people[0].maidenName = '';
  expect(getFamilyMaidenNames(tree).get('anna')).toMatchObject({ value: '', inherited: false, display: '' });
  tree.people[0].maidenName = ' sMiTh ';
  expect(getFamilyMaidenNames(tree).get('anna').display).toBe('');
});

test('unknown or ambiguous fathers do not inherit a guessed surname', () => {
  const tree = namesTree(); delete tree.people[1].relationshipGender;
  expect(getFamilyMaidenNames(tree).get('anna').value).toBe('');
  tree.people[1].relationshipGender = 'male'; tree.people[2].relationshipGender = 'male';
  expect(getFamilyMaidenNames(tree).get('anna').value).toBe('');
  tree.people[2].relationshipGender = 'female'; tree.people[1].name = 'John'; tree.people[1].lastName = '';
  expect(getFamilyMaidenNames(tree).get('anna').value).toBe('');
});

async function seed(page, storageType = 'local', language = 'en', knownFather = true) {
  await page.goto('/');
  const tree = namesTree(); if (!knownFather) delete tree.people[1].relationshipGender;
  await page.evaluate(async ({ tree, storageType, language }) => {
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ language, storageType });
    if (storageType === 'filesystem') {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('maiden-name-archive', { create: true });
      window.showDirectoryPicker = async () => folder;
      if (!await storageService.connectFileSystem()) throw new Error('Could not connect test archive');
    }
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200;
    const context = canvas.getContext('2d'); context.fillStyle = '#6e7e74'; context.fillRect(0, 0, 300, 200);
    await storageService.savePhoto({ id: 'portrait', fileName: 'portrait.png', originalUrl: canvas.toDataURL(), description: 'Test family photo', uploadDate: 1, people: ['Anna Smith'], faceTags: [{ id: 'face', name: 'Anna Smith', x: 40, y: 40 }], tags: [], dateOfPhoto: '', isRestoring: false });
    await storageService.saveFamilyTree(tree);
  }, { tree, storageType, language });
  await page.reload(); await page.getByRole('button', { name: language === 'sk' ? 'Rodokmeň' : 'Family tree', exact: true }).click();
  await expect(page.getByTestId('family-tree-canvas')).toBeVisible();
}
async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    return { tree: await storageService.loadFamilyTree(), photos: await storageService.loadPhotos() };
  });
}
async function edit(page, name = 'Anna Smith') {
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click();
  await page.getByRole('button', { name: `Select ${name}`, exact: true }).click();
  const drawer = page.locator('#family-tree-details');
  await drawer.getByRole('button', { name: 'Edit details', exact: true }).click();
  return drawer.getByRole('form', { name: 'Edit details', exact: true });
}
async function save(form) {
  await form.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(form).toHaveCount(0);
}

for (const storageType of ['local', 'filesystem']) test(`first, last and maiden names persist with photo tags and avatars in ${storageType}`, async ({ page }) => {
  await seed(page, storageType);
  const anna = page.getByRole('button', { name: 'Select Anna Smith', exact: true });
  await expect(anna.locator('.ft-maiden-name')).toHaveText('(Jones)');
  await expect(page.getByRole('button', { name: 'Select Ben Jones', exact: true }).locator('.ft-maiden-name')).toHaveCount(0);
  const form = await edit(page);
  await expect(form.getByRole('textbox', { name: 'First name', exact: true })).toHaveValue('Anna');
  await expect(form.getByRole('textbox', { name: 'Last name', exact: true })).toHaveValue('Smith');
  await expect(form.getByRole('textbox', { name: 'Maiden name', exact: true })).toHaveValue('Jones');
  await form.getByRole('textbox', { name: 'First name', exact: true }).fill(' Anne   Marie ');
  await form.getByRole('textbox', { name: 'Last name', exact: true }).fill(' de   Silva ');
  await form.getByRole('textbox', { name: 'Maiden name', exact: true }).fill(' van   Dijk ');
  await save(form);
  const renamed = page.getByRole('button', { name: 'Select Anne Marie de Silva', exact: true });
  await expect(renamed.locator('.ft-maiden-name')).toHaveText('(van Dijk)');
  await expect(renamed.locator('.ft-portrait')).toHaveAttribute('data-photo-id', 'portrait');
  const state = await stored(page);
  expect(state.tree.people.find(person => person.id === 'anna')).toMatchObject({ name: 'Anne Marie de Silva', firstName: 'Anne Marie', lastName: 'de Silva', maidenName: 'van Dijk', birthDate: '1984-02', relationshipGender: 'female', avatarPhotoId: 'portrait' });
  expect(state.tree.people).toHaveLength(5);
  expect(state.photos[0].people).toEqual(['Anne Marie de Silva']);
  expect(state.photos[0].faceTags).toEqual([{ id: 'face', name: 'Anne Marie de Silva', x: 40, y: 40 }]);
  await page.reload(); await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  await expect(renamed.locator('.ft-maiden-name')).toHaveText('(van Dijk)');
  const reopened = await edit(page, 'Anne Marie de Silva');
  await expect(reopened.getByRole('textbox', { name: 'First name', exact: true })).toHaveValue('Anne Marie');
  await expect(reopened.getByRole('textbox', { name: 'Last name', exact: true })).toHaveValue('de Silva');
  await expect(reopened.getByRole('textbox', { name: 'Maiden name', exact: true })).toHaveValue('van Dijk');
  await reopened.getByRole('textbox', { name: 'Maiden name', exact: true }).fill(' DE   SILVA ');
  await save(reopened);
  await expect(renamed.locator('.ft-maiden-name')).toHaveCount(0);
  expect((await stored(page)).photos[0].people).toEqual(['Anne Marie de Silva']);
});

test('automatic maiden names track father edits while manual values persist and can be cleared or reset', async ({ page }) => {
  await seed(page);
  let form = await edit(page, 'John Jones');
  await form.getByRole('textbox', { name: 'Last name', exact: true }).fill('Brown'); await save(form);
  const anna = page.getByRole('button', { name: 'Select Anna Smith', exact: true });
  await expect(anna.locator('.ft-maiden-name')).toHaveText('(Brown)');
  form = await edit(page); await form.getByRole('textbox', { name: 'Maiden name', exact: true }).fill('Kovac'); await save(form);
  form = await edit(page, 'John Brown'); await form.getByRole('textbox', { name: 'Last name', exact: true }).fill('Green'); await save(form);
  await expect(anna.locator('.ft-maiden-name')).toHaveText('(Kovac)');
  form = await edit(page); await form.getByRole('button', { name: 'Use father’s surname', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Maiden name', exact: true })).toHaveValue('Green'); await save(form);
  await expect(anna.locator('.ft-maiden-name')).toHaveText('(Green)');
  expect((await stored(page)).tree.people.find(person => person.id === 'anna')).not.toHaveProperty('maidenName');
  form = await edit(page); await form.getByRole('textbox', { name: 'Maiden name', exact: true }).fill(''); await save(form);
  await expect(anna.locator('.ft-maiden-name')).toHaveCount(0);
  await page.reload(); await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  expect((await stored(page)).tree.people.find(person => person.id === 'anna').maidenName).toBe('');
  form = await edit(page); await expect(form.getByRole('textbox', { name: 'Maiden name', exact: true })).toHaveValue('');
});

test('setting a father later and adding children updates inherited names without guessing', async ({ page }) => {
  await seed(page, 'local', 'en', false);
  const anna = page.getByRole('button', { name: 'Select Anna Smith', exact: true });
  await expect(anna.locator('.ft-maiden-name')).toHaveCount(0);
  const form = await edit(page, 'John Jones');
  await form.getByRole('combobox', { name: 'Relationship titles', exact: true }).selectOption('male'); await save(form);
  await expect(anna.locator('.ft-maiden-name')).toHaveText('(Jones)');
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click(); await anna.click();
  await page.getByRole('button', { name: 'Add child', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill('Cara Taylor');
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const child = page.getByRole('button', { name: 'Select Cara Taylor', exact: true });
  await expect(child.locator('.ft-maiden-name')).toHaveText('(Smith)');
  expect((await stored(page)).tree.people.find(person => person.name === 'Cara Taylor')).toMatchObject({ firstName: 'Cara', lastName: 'Taylor' });
});

test('the split name editor and maiden name fit on mobile and localize to Slovak', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await seed(page, 'local', 'sk');
  await page.getByRole('button', { name: 'Vybrať Anna Smith', exact: true }).click();
  const drawer = page.locator('#family-tree-details');
  await drawer.getByRole('button', { name: 'Upraviť údaje', exact: true }).click();
  await expect(drawer.getByRole('textbox', { name: 'Krstné meno', exact: true })).toHaveValue('Anna');
  await expect(drawer.getByRole('textbox', { name: 'Priezvisko', exact: true })).toHaveValue('Smith');
  await expect(drawer.getByRole('textbox', { name: 'Rodné priezvisko', exact: true })).toHaveValue('Jones');
  await drawer.getByRole('textbox', { name: 'Priezvisko', exact: true }).fill('Jones');
  await drawer.getByRole('button', { name: 'Uložiť osobu', exact: true }).click();
  const card = page.getByRole('button', { name: 'Vybrať Anna Jones', exact: true });
  await expect(card.locator('.ft-maiden-name')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
