import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import ts from 'typescript';
const dateSource = ts.transpileModule(fs.readFileSync(new URL('../utils/partialDates.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const dates = await import(`data:text/javascript;base64,${Buffer.from(dateSource).toString('base64')}`);

test('partial dates validate calendar dates and compare only information that is known', () => {
  for (const value of ['0001', '1900', '1984-02', '2000-02-29', '2020-04-30', '--01', '--12']) expect(dates.isPartialDate(value), value).toBe(true);
  for (const value of ['', '0000', '1900-02-29', '2001-02-29', '2000-04-31', '2000-00', '2000-13', '2000-01-00', '--00', '--13', 'September', null]) expect(dates.isPartialDate(value), String(value)).toBe(false);
  expect(dates.datesInOrder('1980-12', '1980')).toBe(true);
  expect(dates.datesInOrder('1980', '1980-01')).toBe(true);
  expect(dates.datesInOrder('1980-12', '1980-11')).toBe(false);
  expect(dates.datesInOrder('1980-02-03', '1980-02-02')).toBe(false);
  expect(dates.datesInOrder('--12', '--01')).toBe(true);
  for (const value of ['0001', '1984-02', '2000-02-29', '--09', undefined]) expect(dates.serializePartialDate(dates.partialDateDraft(value))).toBe(value);
  expect(dates.formatPartialDate('--09', 'en')).toBe('September');
  expect(dates.formatPartialDate('2000-02', 'en')).toBe('February 2000');
});

async function seed(page, storageType = 'local') {
  await page.goto('/');
  await page.evaluate(async storageType => {
    const { storageService } = await import('/services/storageService.ts');
    const { emptyFamilyTree, addFamilyMember } = await import('/utils/familyTree.ts');
    storageService.saveSettings({ language: 'en', storageType });
    if (storageType === 'filesystem') {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('person-details-archive', { create: true });
      window.showDirectoryPicker = async () => folder;
      if (!await storageService.connectFileSystem()) throw new Error('Could not connect test archive');
    }
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200;
    const context = canvas.getContext('2d'); context.fillStyle = '#68837a'; context.fillRect(0, 0, 300, 200);
    for (const record of [
      { id: 'face-photo', fileName: 'portrait.png', people: [], faceTags: [{ id: 'face', name: ' ANNA ', x: 35, y: 25 }] },
      { id: 'people-photo', fileName: 'family.png', people: ['Anna', 'Nina'], faceTags: [] },
      { id: 'other-photo', fileName: 'other.png', people: ['Library only'], faceTags: [] },
    ]) await storageService.savePhoto({ ...record, originalUrl: canvas.toDataURL(), uploadDate: 1, description: record.fileName, tags: ['family'], dateOfPhoto: '', isRestoring: false });
    let tree = addFamilyMember(emptyFamilyTree(), 'Anna', { type: 'self' });
    tree = addFamilyMember(tree, 'Peter', { type: 'spouse', personId: tree.rootId });
    tree = addFamilyMember(tree, 'Nina', { type: 'child', personId: tree.rootId });
    tree = addFamilyMember(tree, 'Alice', { type: 'parent', personId: tree.rootId });
    tree = addFamilyMember(tree, 'Bob', { type: 'parent', personId: tree.rootId });
    tree.people.find(person => person.id === tree.rootId).avatarPhotoId = 'face-photo';
    await storageService.saveFamilyTree(tree);
  }, storageType);
  await page.reload();
  await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  await expect(page.getByTestId('family-tree-canvas')).toBeVisible();
}
async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    return { tree: await storageService.loadFamilyTree(), photos: await storageService.loadPhotos() };
  });
}
async function selectPerson(page, name) {
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click();
  await page.getByRole('button', { name: `Select ${name}`, exact: true }).click();
  return page.locator('#family-tree-details');
}
async function editPerson(page, name = 'Anna') {
  const drawer = await selectPerson(page, name);
  await drawer.getByRole('button', { name: 'Edit details', exact: true }).click();
  return drawer.getByRole('form', { name: 'Edit details', exact: true });
}
async function setDate(form, label, precision, parts = {}) {
  await form.getByRole('combobox', { name: `${label} precision`, exact: true }).selectOption(precision);
  if (parts.year) await form.getByRole('spinbutton', { name: `${label} year`, exact: true }).fill(parts.year);
  if (parts.month) await form.getByRole('combobox', { name: `${label} month`, exact: true }).selectOption(parts.month);
  if (parts.day) await form.getByRole('spinbutton', { name: `${label} day`, exact: true }).fill(parts.day);
}

for (const storageType of ['local', 'filesystem']) test(`drawer edits keep shared names, avatars and partial dates after reload in ${storageType}`, async ({ page }) => {
  await seed(page, storageType);
  const before = await stored(page);
  const form = await editPerson(page);
  await form.getByRole('textbox', { name: 'First name', exact: true }).fill('  Anna  ');
  await form.getByRole('textbox', { name: 'Last name', exact: true }).fill('  Nováková  ');
  await form.getByRole('textbox', { name: 'Location 1', exact: true }).fill('  Bratislava, Slovakia  ');
  await form.getByRole('button', { name: 'Add location', exact: true }).click();
  await form.getByRole('textbox', { name: 'Location 2', exact: true }).fill('Prague, Czechia');
  await setDate(form, 'Date of birth', 'year', { year: '1984' });
  await setDate(form, 'Date of death', 'month', { year: '2020', month: '9' });
  await form.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(form).toHaveCount(0);
  const drawer = page.locator('#family-tree-details');
  await expect(drawer.getByRole('heading', { name: 'Anna Nováková', exact: true })).toBeVisible();
  await expect(drawer.locator('dl')).toContainText('Bratislava, Slovakia');
  await expect(drawer.locator('dl')).toContainText('Prague, Czechia');
  await expect(drawer.locator('dl')).toContainText('1984');
  await expect(drawer.locator('dl')).toContainText('September 2020');
  await expect(drawer.locator('.ft-portrait')).toHaveAttribute('data-photo-id', 'face-photo');
  const after = await stored(page);
  expect(after.tree.rootId).toBe(before.tree.rootId);
  expect(after.tree.families).toEqual(before.tree.families);
  expect(after.tree.people.find(person => person.id === after.tree.rootId)).toMatchObject({ name: 'Anna Nováková', locations: ['Bratislava, Slovakia', 'Prague, Czechia'], birthDate: '1984', deathDate: '2020-09', avatarPhotoId: 'face-photo' });
  expect(after.photos.find(photo => photo.id === 'face-photo').faceTags).toEqual([{ id: 'face', name: 'Anna Nováková', x: 35, y: 25 }]);
  expect(after.photos.find(photo => photo.id === 'people-photo').people).toEqual(['Anna Nováková', 'Nina']);
  expect(after.photos.find(photo => photo.id === 'other-photo').people).toEqual(['Library only']);
  for (const photo of after.photos) expect(photo.tags).toEqual(['family']);
  if (storageType === 'filesystem') {
    const raw = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('person-details-archive');
      return JSON.parse(await (await (await folder.getFileHandle('ancestry_db.json')).getFile()).text());
    });
    expect(raw.every(photo => photo.originalUrl.startsWith('images/') && photo.thumbnailUrl.startsWith('images/'))).toBe(true);
  }
  await page.reload();
  await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  const reopened = await editPerson(page, 'Anna Nováková');
  await expect(reopened.getByRole('combobox', { name: 'Date of birth precision', exact: true })).toHaveValue('year');
  await expect(reopened.getByRole('spinbutton', { name: 'Date of birth year', exact: true })).toHaveValue('1984');
  await expect(reopened.getByRole('textbox', { name: 'Location 1', exact: true })).toHaveValue('Bratislava, Slovakia');
  await expect(reopened.getByRole('textbox', { name: 'Location 2', exact: true })).toHaveValue('Prague, Czechia');
  await reopened.getByRole('button', { name: 'Remove location 2', exact: true }).click();
  await reopened.getByRole('textbox', { name: 'Location 1', exact: true }).fill('   ');
  await setDate(reopened, 'Date of birth', 'none');
  await setDate(reopened, 'Date of death', 'none');
  await reopened.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(reopened).toHaveCount(0);
  const cleared = (await stored(page)).tree.people.find(person => person.name === 'Anna Nováková');
  expect(cleared).not.toHaveProperty('location');
  expect(cleared).not.toHaveProperty('locations');
  expect(cleared).not.toHaveProperty('birthDate'); expect(cleared).not.toHaveProperty('deathDate');
});

test('full and month-only dates work on mobile, and cancel discards a draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  const form = await editPerson(page);
  await setDate(form, 'Date of birth', 'monthOnly', { month: '9' });
  await expect(form.getByRole('spinbutton', { name: 'Date of birth year', exact: true })).toHaveCount(0);
  await setDate(form, 'Date of death', 'date', { year: '2020', month: '2', day: '29' });
  await form.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(form).toHaveCount(0);
  const person = (await stored(page)).tree.people.find(person => person.name === 'Anna');
  expect(person).toMatchObject({ birthDate: '--09', deathDate: '2020-02-29' });
  const drawer = page.locator('#family-tree-details');
  await expect(drawer.locator('dl')).toContainText('September');
  await expect(drawer.locator('dl')).toContainText('February 29, 2020');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await drawer.getByRole('button', { name: 'Edit details', exact: true }).click();
  await drawer.getByRole('textbox', { name: 'First name', exact: true }).fill('Discarded name');
  await drawer.getByRole('textbox', { name: 'Location 1', exact: true }).fill('Discarded location');
  await page.keyboard.press('Escape');
  await expect(drawer.getByRole('form')).toHaveCount(0);
  await expect(drawer.getByRole('heading', { name: 'Anna', exact: true })).toBeVisible();
  const unchanged = (await stored(page)).tree.people.find(item => item.id === person.id);
  expect(unchanged.name).toBe('Anna');
  expect(unchanged).not.toHaveProperty('location');
  expect(unchanged).not.toHaveProperty('locations');
  await drawer.getByRole('button', { name: 'Edit details', exact: true }).click();
  await expect(drawer.getByRole('textbox', { name: 'Location 1', exact: true })).toHaveValue('');
});

test('duplicate names, impossible dates, and death before birth are rejected', async ({ page }) => {
  await seed(page);
  const form = await editPerson(page);
  const name = form.getByRole('textbox', { name: 'First name', exact: true });
  const save = form.getByRole('button', { name: 'Save person', exact: true });
  await name.fill('Peter'); await save.click();
  await expect(form.getByRole('alert')).toContainText('already used');
  await name.fill('Library only'); await save.click();
  await expect(form.getByRole('alert')).toContainText('already used');
  await name.fill('   '); await save.click();
  await expect(form.getByRole('alert')).toContainText('Enter a person');
  await name.fill('Anna');
  await setDate(form, 'Date of birth', 'date', { year: '1900', month: '2', day: '29' }); await save.click();
  await expect(form.getByRole('alert')).toContainText('valid date');
  await setDate(form, 'Date of birth', 'year', { year: '2000' });
  await setDate(form, 'Date of death', 'year', { year: '1999' }); await save.click();
  await expect(form.getByRole('alert')).toContainText('cannot be before');
  expect((await stored(page)).tree.people.find(person => person.name === 'Anna')).not.toHaveProperty('birthDate');
});

for (const failureStage of ['tree', 'photos']) test(`failed ${failureStage} writes preserve old names and allow a retry`, async ({ page }) => {
  await seed(page);
  const form = await editPerson(page);
  await form.getByRole('textbox', { name: 'First name', exact: true }).fill('Renamed Anna');
  await page.evaluate(failureStage => {
    window.realPersonPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (failureStage === 'tree' && this.name === 'tree' || failureStage === 'photos' && this.name === 'photos' && value.id === 'people-photo' && value.people.includes('Renamed Anna')) throw new DOMException('Test denied', 'QuotaExceededError');
      return window.realPersonPut.call(this, value, ...args);
    };
  }, failureStage);
  await form.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('could not be saved');
  const failed = await stored(page);
  expect(failed.tree.people.some(person => person.name === 'Renamed Anna')).toBe(false);
  expect(failed.photos.find(photo => photo.id === 'people-photo').people).toEqual(['Anna', 'Nina']);
  expect(failed.photos.find(photo => photo.id === 'face-photo').faceTags[0].name).toBe(' ANNA ');
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.realPersonPut; });
  await form.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select Renamed Anna', exact: true })).toBeVisible();
});

test('only people without children can be deleted and photo tags remain', async ({ page }) => {
  await seed(page);
  let drawer = await selectPerson(page, 'Anna');
  await expect(drawer.getByRole('button', { name: 'Delete person', exact: true })).toBeDisabled();
  await expect(drawer).toContainText('has children and cannot be deleted');
  const code = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const { removeFamilyMember } = await import('/utils/familyTree.ts');
    const tree = await storageService.loadFamilyTree();
    try { removeFamilyMember(tree, tree.rootId); return 'accepted'; } catch (error) { return error.code; }
  });
  expect(code).toBe('hasChildren');
  drawer = await selectPerson(page, 'Nina');
  await drawer.getByRole('button', { name: 'Delete person', exact: true }).click();
  let confirm = page.getByRole('dialog', { name: 'Delete person', exact: true });
  await expect(confirm).toContainText('photo tags will be kept');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await stored(page)).tree.people.some(person => person.name === 'Nina')).toBe(true);
  await drawer.getByRole('button', { name: 'Delete person', exact: true }).click();
  await confirm.getByRole('button', { name: 'Delete person', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  let state = await stored(page);
  expect(state.tree.people.some(person => person.name === 'Nina')).toBe(false);
  expect(state.photos.find(photo => photo.id === 'people-photo').people).toEqual(['Anna', 'Nina']);
  expect(state.tree.families.some(family => family.childIds.length)).toBe(true); // Anna still has parents.
  drawer = await selectPerson(page, 'Peter');
  await drawer.getByRole('button', { name: 'Delete person', exact: true }).click();
  await confirm.getByRole('button', { name: 'Delete person', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  state = await stored(page);
  expect(state.tree.people.some(person => person.name === 'Peter')).toBe(false);
  expect(state.tree.families.some(family => family.parentIds.length === 1 && family.childIds.length === 0)).toBe(false);
  await page.reload(); await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  drawer = await selectPerson(page, 'Anna');
  await drawer.getByRole('button', { name: 'Delete person', exact: true }).click();
  await expect(confirm).toContainText('choose the starting person again');
  await confirm.getByRole('button', { name: 'Delete person', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start with you', exact: true })).toBeVisible();
  state = await stored(page);
  expect(state.tree.rootId).toBeNull();
  expect(state.tree.people.map(person => person.name).sort()).toEqual(['Alice', 'Bob']);
  await page.getByRole('combobox', { name: 'Your name', exact: true }).fill('Alice');
  await page.getByRole('button', { name: 'Start my tree', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Alice', exact: true })).toBeVisible();
  expect((await stored(page)).tree.people).toHaveLength(2);
});

test('a failed delete keeps the person and their relationships', async ({ page }) => {
  await seed(page);
  const before = (await stored(page)).tree;
  const drawer = await selectPerson(page, 'Nina');
  await drawer.getByRole('button', { name: 'Delete person', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete person', exact: true });
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Test denied', 'QuotaExceededError'); }; });
  await confirm.getByRole('button', { name: 'Delete person', exact: true }).click();
  await expect(confirm.getByRole('alert')).toContainText('could not be saved');
  expect((await stored(page)).tree).toEqual(before);
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(drawer.getByRole('heading', { name: 'Nina', exact: true })).toBeVisible();
});


test('legacy single locations migrate and multiple locations survive unrelated edits', async ({ page }) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { validateFamilyTree, updateFamilyMember } = await import('/utils/familyTree.ts');
    const legacy = { rootId: 'person', people: [{ id: 'person', name: 'Anna', location: '  Bratislava  ' }], families: [] };
    const migrated = validateFamilyTree(legacy);
    const multiple = updateFamilyMember(migrated, 'person', { locations: [' Bratislava ', 'Prague', '', 'Prague'] });
    const renamed = updateFamilyMember(multiple, 'person', { name: 'Anna Smith' });
    let invalid;
    try { validateFamilyTree({ ...legacy, people: [{ ...legacy.people[0], locations: [123] }] }); }
    catch (error) { invalid = error.code; }
    return { migrated, renamed, invalid };
  });
  expect(result.migrated.people[0].locations).toEqual(['Bratislava']);
  expect(result.migrated.people[0]).not.toHaveProperty('location');
  expect(result.renamed.people[0].locations).toEqual(['Bratislava', 'Prague']);
  expect(result.invalid).toBe('invalidTree');
});
