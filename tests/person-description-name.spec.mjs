import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(fs.readFileSync(new URL('../utils/people.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { getPhotoDescriptionPeople, applyPhotoDescriptionNames } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('description reference names are resolved locally for tagged people only', () => {
  const photo = { people: [' anna smith ', 'Unknown person'], faceTags: [{ id: 'f1', name: 'ANNA SMITH', x: 25, y: 40 }, { id: 'f2', name: 'John Jones', x: 65, y: 35 }] };
  const familyPeople = [
    { name: 'Anna Smith', descriptionName: '  Grandma   Anna ', birthDate: '1940' },
    { name: 'John Jones', descriptionName: '  ' },
    { name: 'Unrelated person', descriptionName: 'Do not include this person' },
  ];
  const before = JSON.stringify({ photo, familyPeople });
  expect(getPhotoDescriptionPeople(photo, familyPeople)).toEqual([
    { name: 'Anna Smith', descriptionName: 'Grandma Anna' },
    { name: 'John Jones', descriptionName: 'John Jones' },
    { name: 'Unknown person', descriptionName: 'Unknown person' },
  ]);
  expect(JSON.stringify({ photo, familyPeople })).toBe(before);
});

async function seed(page, storageType = 'local', language = 'en') {
  await page.goto('/');
  await page.evaluate(async ({ storageType, language }) => {
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ storageType, language });
    if (storageType === 'filesystem') {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('description-name-archive', { create: true });
      window.showDirectoryPicker = async () => folder;
      if (!await storageService.connectFileSystem()) throw new Error('Could not connect test archive');
    }
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200;
    const context = canvas.getContext('2d'); context.fillStyle = '#657c73'; context.fillRect(0, 0, 300, 200);
    await storageService.savePhoto({ id: 'portrait', fileName: 'portrait.png', originalUrl: canvas.toDataURL(), description: 'Anna Smith in the garden.', uploadDate: 1, people: ['Anna Smith'], faceTags: [{ id: 'face', name: 'Anna Smith', x: 40, y: 35 }], tags: ['garden'], dateOfPhoto: '', isRestoring: false });
    await storageService.saveFamilyTree({ rootId: 'anna', people: [{ id: 'anna', name: 'Anna Smith', firstName: 'Anna', lastName: 'Smith', maidenName: 'Jones', birthDate: '1940', relationshipGender: 'female', avatarPhotoId: 'portrait' }], families: [] });
  }, { storageType, language });
  await page.reload();
  await page.getByRole('button', { name: language === 'sk' ? 'Rodokmeň' : 'Family tree', exact: true }).click();
  await expect(page.getByTestId('family-tree-canvas')).toBeVisible();
}
async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    return { tree: await storageService.loadFamilyTree(), photos: await storageService.loadPhotos() };
  });
}
async function edit(page) {
  await page.locator('#family-tree-details').getByRole('button', { name: 'Edit details', exact: true }).click();
  return page.getByRole('form', { name: 'Edit details', exact: true });
}
async function save(form) {
  await form.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(form).toHaveCount(0);
}

for (const storageType of ['local', 'filesystem']) test(`preferred photo-description name saves and clears locally in ${storageType}`, async ({ page }) => {
  let requests = 0;
  await page.route('https://generativelanguage.googleapis.com/**', route => { requests++; return route.abort(); });
  await seed(page, storageType);
  const before = await stored(page);
  let form = await edit(page);
  const field = form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true });
  await expect(field).toHaveValue(''); await expect(field).toHaveAttribute('placeholder', 'Anna Smith');
  await expect(form.getByRole('note')).toContainText('Google Gemini, an external AI service');
  await expect(form.getByRole('note')).toContainText('Saving this field alone sends no AI request');
  await expect(field).toHaveAccessibleDescription(/Auto-Analyze.*tagged people’s names.*Google Gemini/);
  await field.fill('  Grandma   Anna  '); await save(form);
  await expect(page.locator('.ft-life-dates')).toContainText('Name in photo descriptions');
  await expect(page.locator('.ft-life-dates')).toContainText('Grandma Anna');
  await expect(page.locator('#family-tree-details').getByRole('note')).toContainText('Google Gemini');
  await expect(page.getByRole('button', { name: 'Select Anna Smith', exact: true }).locator('strong')).toHaveText('Anna Smith');
  let state = await stored(page);
  expect(state.tree.people[0]).toMatchObject({ name: 'Anna Smith', firstName: 'Anna', lastName: 'Smith', descriptionName: 'Grandma Anna', maidenName: 'Jones', birthDate: '1940', avatarPhotoId: 'portrait' });
  expect(state.photos[0].description).toBe(before.photos[0].description);
  expect(state.photos[0].people).toEqual(before.photos[0].people);
  expect(state.photos[0].faceTags).toEqual(before.photos[0].faceTags);
  await page.reload(); await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  form = await edit(page);
  await expect(form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true })).toHaveValue('Grandma Anna');
  await form.getByRole('textbox', { name: 'Last name', exact: true }).fill('Brown'); await save(form);
  state = await stored(page);
  expect(state.tree.people[0]).toMatchObject({ name: 'Anna Brown', descriptionName: 'Grandma Anna' });
  expect(state.photos[0].people).toEqual(['Anna Brown']);
  form = await edit(page);
  await expect(form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true })).toHaveAttribute('placeholder', 'Anna Brown');
  await form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true }).fill('   '); await save(form);
  expect((await stored(page)).tree.people[0]).not.toHaveProperty('descriptionName');
  expect(requests).toBe(0);
});

test('a failed preference save preserves the saved person and can be retried', async ({ page }) => {
  await seed(page);
  let form = await edit(page);
  await form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true }).fill('Grandma Anna'); await save(form);
  const before = await stored(page);
  form = await edit(page);
  await form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true }).fill('Granny');
  await page.evaluate(() => {
    window.realDescriptionPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'tree') throw new DOMException('Test denied', 'QuotaExceededError');
      return window.realDescriptionPut.call(this, value, ...args);
    };
  });
  await form.getByRole('button', { name: 'Save person', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('could not be saved');
  expect((await stored(page)).tree).toEqual(before.tree);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.realDescriptionPut; });
  await save(form);
  expect((await stored(page)).tree.people[0].descriptionName).toBe('Granny');
});

test('the optional reference field works in the mobile Slovak drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await seed(page, 'local', 'sk');
  await page.getByRole('button', { name: 'Vybrať Anna Smith', exact: true }).click();
  const drawer = page.locator('#family-tree-details');
  await drawer.getByRole('button', { name: 'Upraviť údaje', exact: true }).click();
  const referenceField = drawer.getByRole('textbox', { name: 'Meno v popisoch fotografií', exact: true });
  await expect(referenceField).toHaveAccessibleDescription(/Google Gemini/);
  await expect(drawer.getByRole('note')).toContainText('externej službe umelej inteligencie');
  await referenceField.fill('babka Anna');
  await drawer.getByRole('button', { name: 'Uložiť osobu', exact: true }).click();
  await expect(drawer.locator('.ft-life-dates')).toContainText('babka Anna');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('profile validation normalizes the preference and preserves it when unrelated fields change', async ({ page }) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const { validateFamilyTree, updateFamilyMember } = await import('/utils/familyTree.ts');
    const original = await storageService.loadFamilyTree();
    const next = updateFamilyMember(original, 'anna', { descriptionName: '  Grandma   Anna ', birthDate: '1940', relationshipGender: 'female' });
    const renamed = updateFamilyMember(next, 'anna', { firstName: 'Anne', lastName: 'Smith' });
    const malformed = structuredClone(original); malformed.people[0].descriptionName = 42;
    let code;
    try { validateFamilyTree(malformed); } catch (error) { code = error.code; }
    return { normalized: next.people[0].descriptionName, retained: renamed.people[0].descriptionName, originalChanged: 'descriptionName' in original.people[0], code };
  });
  expect(result).toEqual({ normalized: 'Grandma Anna', retained: 'Grandma Anna', originalChanged: false, code: 'invalidTree' });
});


const geminiReply = description => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ description, tags: ['garden', 'outdoors'], people_count: 3, location: '' }) }] } }] });
const requestContext = body => {
  const part = body.contents.flatMap(content => content.parts).find(part => part.text?.startsWith('Describe this family archive image'));
  return JSON.parse(part.text.slice(part.text.indexOf('\n') + 1));
};
async function openPhotoEditor(page) {
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.getByRole('img', { name: 'Anna Smith in the garden.', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  return page.getByRole('dialog', { name: 'Photo Details', exact: true });
}

test('Auto-Analyze sends selected-photo reference names and keeps them on availability fallback', async ({ page }) => {
  await seed(page);
  const form = await edit(page);
  await form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true }).fill('Grandma Anna'); await save(form);
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const tree = await storageService.loadFamilyTree();
    tree.people.push({ id: 'john', name: 'John Jones', descriptionName: 'Grandpa John', birthDate: '1938' }, { id: 'unrelated', name: 'Unrelated person', descriptionName: 'Never include me', birthDate: '1910' });
    await storageService.saveFamilyTree(tree);
    const photo = (await storageService.loadPhotos())[0];
    await storageService.savePhoto({ ...photo, people: ['Anna Smith', 'John Jones', 'Unknown person'] });
  });
  await page.reload();
  const requests = [];
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (requests.length === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Test unavailable' } }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(geminiReply('Grandma Anna and Grandpa John are in the garden.')) });
  });
  const editor = await openPhotoEditor(page);
  await editor.getByRole('button', { name: 'Auto-Analyze', exact: true }).click();
  await expect(editor.locator('textarea')).toHaveValue('Grandma Anna and Grandpa John are in the garden.');
  expect(requests).toHaveLength(2);
  const context = requestContext(requests[0]);
  expect(context.taggedPeople).toEqual([
    { name: 'Grandma Anna' },
    { name: 'Grandpa John' },
    { name: 'Unknown person' },
  ]);
  expect(context.namedPeople).toEqual([{ name: 'Grandma Anna', xPercent: 40, yPercent: 35 }]);
  expect(requestContext(requests[1])).toEqual(context);
  expect(JSON.stringify(context)).not.toMatch(/Anna Smith|John Jones|Unrelated|Never include|birthDate|1940|1938|1910|maidenName/);
  expect(JSON.stringify(requests[0].systemInstruction)).toContain('use their name exactly as provided');
  expect(JSON.stringify(requests[0].systemInstruction)).toContain('literal reference label');
  const state = await stored(page);
  expect(state.photos[0].people).toEqual(['Anna Smith', 'John Jones', 'Unknown person']);
  expect(state.photos[0].faceTags).toEqual([{ id: 'face', name: 'Anna Smith', x: 40, y: 35 }]);
  expect(state.tree.people.find(person => person.id === 'anna').name).toBe('Anna Smith');
});

test('Auto-Analyze preserves a description edited while the request is pending', async ({ page }) => {
  await seed(page);
  const form = await edit(page);
  await form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true }).fill('Grandma Anna'); await save(form);
  let pending;
  await page.route('https://generativelanguage.googleapis.com/**', route => { pending = route; });
  const editor = await openPhotoEditor(page);
  await editor.getByRole('button', { name: 'Auto-Analyze', exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  expect(requestContext(pending.request().postDataJSON()).namedPeople[0].name).toBe('Grandma Anna');
  await editor.locator('textarea').fill('My manually edited caption.');
  await expect.poll(async () => (await stored(page)).photos[0].description).toBe('My manually edited caption.');
  await pending.fulfill({ contentType: 'application/json', body: JSON.stringify(geminiReply('Grandma Anna is in the garden.')) });
  await expect(editor.getByRole('button', { name: 'Auto-Analyze', exact: true })).toBeEnabled();
  await expect(editor.locator('textarea')).toHaveValue('My manually edited caption.');
  expect((await stored(page)).photos[0].description).toBe('My manually edited caption.');
});

test('Auto-Analyze applies the preferred description name even when Gemini returns the archive name', async ({ page }) => {
  await seed(page);
  const form = await edit(page);
  await form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true }).fill('Grandma Anna');
  await save(form);
  await page.route('https://generativelanguage.googleapis.com/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(geminiReply("Anna Smith's portrait is set in a garden.")),
  }));
  const editor = await openPhotoEditor(page);
  await editor.getByRole('button', { name: 'Auto-Analyze', exact: true }).click();
  await expect(editor.locator('textarea')).toHaveValue("Grandma Anna's portrait is set in a garden.");
  await expect.poll(async () => (await stored(page)).photos[0].description).toBe("Grandma Anna's portrait is set in a garden.");
  const state = await stored(page);
  expect(state.photos[0].people).toEqual(['Anna Smith']);
  expect(state.photos[0].faceTags[0].name).toBe('Anna Smith');
});

for (const { title, description, people, expected } of [
  {
    title: 'full names and possessives',
    description: "ANNA SMITH and John Jones are outdoors. Anna Smith's coat is blue.",
    people: [{ name: 'Anna Smith', descriptionName: 'Grandma Anna' }, { name: 'John Jones', descriptionName: 'Grandpa John' }],
    expected: "Grandma Anna and Grandpa John are outdoors. Grandma Anna's coat is blue.",
  },
  {
    title: 'existing labels, overlapping names, and word boundaries',
    description: 'Grandma Anna Smith, Anna Smith, Anna Brown, Ann Smithson and Joann Smith.',
    people: [{ name: 'Anna Smith', descriptionName: 'Grandma Anna Smith' }, { name: 'Anna Brown', descriptionName: 'Anna Brown' }, { name: 'Ann Smith', descriptionName: 'Aunt Ann' }],
    expected: 'Grandma Anna Smith, Grandma Anna Smith, Anna Brown, Ann Smithson and Joann Smith.',
  },
  {
    title: 'accented names and varying whitespace',
    description: 'MÁRIA\tDRINKOVÁ is outdoors.',
    people: [{ name: 'Mária Drinková', descriptionName: 'babka Mária' }],
    expected: 'babka Mária is outdoors.',
  },
  {
    title: 'literal punctuation in names and replacement labels',
    description: 'Dr. A+B (Jr.) is outdoors.',
    people: [{ name: 'Dr. A+B (Jr.)', descriptionName: 'Grandpa $&' }],
    expected: 'Grandpa $& is outdoors.',
  },
  {
    title: 'names without preferences',
    description: 'Anna Smith and an unnamed person are outdoors.',
    people: [{ name: 'Anna Smith', descriptionName: '' }],
    expected: 'Anna Smith and an unnamed person are outdoors.',
  },
]) test(`caption name enforcement handles ${title}`, () => {
  const before = JSON.stringify(people);
  expect(applyPhotoDescriptionNames(description.normalize('NFD'), people)).toBe(expected);
  expect(JSON.stringify(people)).toBe(before);
});

test('Auto-Analyze uses a natural date in the request and saved caption without changing metadata', async ({ page }) => {
  await seed(page);
  const form = await edit(page);
  await form.getByRole('textbox', { name: 'Name in photo descriptions', exact: true }).fill('Grandma Anna');
  await save(form);
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const photo = (await storageService.loadPhotos())[0];
    await storageService.savePhoto({ ...photo, dateOfPhoto: '2008-01-01' });
  });
  await page.reload();
  let request;
  await page.route('https://generativelanguage.googleapis.com/**', route => {
    request = route.request().postDataJSON();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(geminiReply('Anna Smith is at home on 2008-01-01.')) });
  });
  const editor = await openPhotoEditor(page);
  await editor.getByRole('button', { name: 'Auto-Analyze', exact: true }).click();
  await expect(editor.locator('textarea')).toHaveValue('Grandma Anna is at home on January 1, 2008.');
  expect(requestContext(request).date).toBe('January 1, 2008');
  expect(JSON.stringify(request.contents)).not.toContain('2008-01-01');
  expect(JSON.stringify(request.systemInstruction)).toContain('never copy an ISO date');
  const state = await stored(page);
  expect(state.photos[0].dateOfPhoto).toBe('2008-01-01');
  expect(state.photos[0].people).toEqual(['Anna Smith']);
});
