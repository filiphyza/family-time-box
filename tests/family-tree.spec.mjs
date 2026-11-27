import { test, expect } from '@playwright/test';

async function seedPhoto(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext('2d'); context.fillStyle = '#687b8d'; context.fillRect(0, 0, 600, 400);
    await storageService.savePhoto({
      id: 'tree-photo', fileName: 'family-photo.png', originalUrl: canvas.toDataURL(), uploadDate: 1,
      description: 'Family tree test memory', people: ['Anna'], tags: [], dateOfPhoto: '', isRestoring: false,
      faceTags: [{ id: 'legacy-face', name: 'Mária', x: 30, y: 30 }],
    });
  });
  await page.reload();
  await expect(page.getByRole('img', { name: 'Family tree test memory', exact: true })).toBeVisible();
}

async function openTree(page) {
  await page.getByRole('button', { name: 'Family tree', exact: true }).click();
}

async function startTree(page, name = 'Mária') {
  await openTree(page);
  await expect(page.getByRole('heading', { name: 'Start with you', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Your name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Start my tree', exact: true }).click();
  await expect(page.getByRole('button', { name: `Select ${name}`, exact: true })).toBeVisible();
  await expect.poll(async () => (await storedTree(page)).people.length).toBe(1);
}

async function storedTree(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    return storageService.loadFamilyTree();
  });
}

async function addRelative(page, person, action, name) {
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click();
  await page.getByRole('button', { name: `Select ${person}`, exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await storedTree(page)).people.some(person => person.name === name)).toBe(true);
}

function familyNames(tree, child) {
  const id = tree.people.find(person => person.name === child)?.id;
  const family = tree.families.find(family => family.childIds.includes(id));
  return family?.parentIds.map(id => tree.people.find(person => person.id === id).name).sort();
}

test('photo tags can start the tree and new tree names are available when tagging photos', async ({ page }) => {
  await seedPhoto(page);
  await openTree(page);
  const input = page.getByRole('combobox', { name: 'Your name', exact: true });
  await input.fill('már');
  await page.getByRole('option', { name: 'Mária', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Mária', exact: true })).toBeVisible();
  await addRelative(page, 'Mária', 'Add spouse', 'Peter');

  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.getByRole('img', { name: 'Family tree test memory', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Photo Details', exact: true });
  await editor.getByRole('combobox', { name: 'Person name', exact: true }).fill('Pet');
  await editor.getByRole('option', { name: 'Peter', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Remove person: Peter', exact: true })).toBeVisible();
  const photo = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    return (await storageService.loadPhotos()).find(photo => photo.id === 'tree-photo');
  });
  expect(photo.people).toEqual(['Anna', 'Peter']);
  expect(photo.faceTags.map(tag => tag.name)).toEqual(['Mária']);
  await page.reload();
  await openTree(page);
  expect((await storedTree(page)).people.map(person => person.name)).toEqual(['Mária', 'Peter']);
});

test('both spouse branches, children, and grandchildren keep their family links after reload', async ({ page }) => {
  await seedPhoto(page);
  await startTree(page);
  await addRelative(page, 'Mária', 'Add spouse', 'Peter');
  await addRelative(page, 'Mária', 'Add parent', 'Anna');
  await addRelative(page, 'Mária', 'Add parent', 'Jozef');
  await addRelative(page, 'Peter', 'Add parent', 'Eva');
  await addRelative(page, 'Peter', 'Add parent', 'Milan');
  await addRelative(page, 'Mária', 'Add child', 'Nina');
  await addRelative(page, 'Peter', 'Add child', 'Tomáš');
  await addRelative(page, 'Nina', 'Add spouse', 'David');
  await addRelative(page, 'Nina', 'Add child', 'Lea');
  await addRelative(page, 'Anna', 'Add parent', 'Helena');

  const tree = await storedTree(page);
  expect(tree.people).toHaveLength(11);
  expect(familyNames(tree, 'Mária')).toEqual(['Anna', 'Jozef']);
  expect(familyNames(tree, 'Peter')).toEqual(['Eva', 'Milan']);
  expect(familyNames(tree, 'Nina')).toEqual(['Mária', 'Peter']);
  expect(familyNames(tree, 'Tomáš')).toEqual(['Mária', 'Peter']);
  expect(familyNames(tree, 'Lea')).toEqual(['David', 'Nina']);
  expect(familyNames(tree, 'Anna')).toEqual(['Helena']);
  await page.reload();
  await openTree(page);
  expect(await storedTree(page)).toEqual(tree);
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click();
  for (const person of tree.people) {
    await expect(page.getByRole('button', { name: `Select ${person.name}`, exact: true })).toBeVisible();
  }
});

test('initial view is centered on me and zoom, drag, and recenter work after reload', async ({ page }) => {
  await seedPhoto(page);
  await startTree(page);
  await addRelative(page, 'Mária', 'Add spouse', 'Peter');
  await addRelative(page, 'Mária', 'Add parent', 'Anna');
  await page.reload();
  await openTree(page);
  const canvas = page.getByTestId('family-tree-canvas');
  const me = page.getByRole('button', { name: 'Select Mária', exact: true });
  const assertCentered = async () => {
    const viewport = await canvas.boundingBox();
    const root = await me.boundingBox();
    expect(Math.abs(root.x + root.width / 2 - viewport.x - viewport.width / 2)).toBeLessThan(3);
    expect(Math.abs(root.y + root.height / 2 - viewport.y - viewport.height / 2)).toBeLessThan(3);
  };
  await expect(canvas).toBeVisible();
  await assertCentered();
  const initialScale = Number(await canvas.getAttribute('data-scale'));
  expect(initialScale).toBeGreaterThanOrEqual(0.5);
  expect(initialScale).toBeLessThanOrEqual(1.25);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-scale'))).toBeGreaterThan(initialScale);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-scale'))).toBeCloseTo(initialScale, 2);
  const bounds = await canvas.boundingBox();
  const before = await me.boundingBox();
  await page.mouse.move(bounds.x + 25, bounds.y + 25);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 105, bounds.y + 85, { steps: 5 });
  await page.mouse.up();
  const after = await me.boundingBox();
  const viewportAfterDrag = await canvas.boundingBox();
  expect((after.x - viewportAfterDrag.x) - (before.x - bounds.x)).toBeCloseTo(80, 0);
  expect((after.y - viewportAfterDrag.y) - (before.y - bounds.y)).toBeCloseTo(60, 0);
  await page.getByRole('button', { name: 'Center on me', exact: true }).click();
  await assertCentered();
  const wheelBounds = await canvas.boundingBox();
  await page.mouse.move(wheelBounds.x + 30, wheelBounds.y + 30);
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => Number(await canvas.getAttribute('data-scale'))).toBeGreaterThan(initialScale);
  const wheelScale = Number(await canvas.getAttribute('data-scale'));
  await canvas.focus();
  await page.keyboard.press('-');
  await expect.poll(async () => Number(await canvas.getAttribute('data-scale'))).toBeLessThan(wheelScale);
  await page.keyboard.press('Home');
  await expect.poll(async () => Number(await canvas.getAttribute('data-scale'))).toBeCloseTo(initialScale, 2);
  await assertCentered();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Center on me', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertCentered();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('family tree belongs to its selected archive and connected folder writes preserve photo metadata', async ({ page }) => {
  await seedPhoto(page);
  await startTree(page);
  const localTree = await storedTree(page);
  const result = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const { emptyFamilyTree, addFamilyMember } = await import('/utils/familyTree.ts');
    const root = await navigator.storage.getDirectory();
    const folderA = await root.getDirectoryHandle('family-tree-archive-a', { create: true });
    const folderB = await root.getDirectoryHandle('family-tree-archive-b', { create: true });
    storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
    window.showDirectoryPicker = async () => folderA;
    if (!await storageService.connectFileSystem()) throw new Error('Could not connect test folder');
    const initiallyEmpty = await storageService.loadFamilyTree();
    const treeA = addFamilyMember(emptyFamilyTree(), 'Archive A person', { type: 'self' });
    await storageService.saveFamilyTree(treeA);
    await storageService.savePhoto({
      id: 'folder-photo', fileName: 'folder.png', originalUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0xQAAAAASUVORK5CYII=',
      uploadDate: 1, description: 'Preserved photo', people: ['Photo person'], tags: [], faceTags: [], dateOfPhoto: '', isRestoring: false,
    });
    const updatedTreeA = addFamilyMember(treeA, 'Archive A spouse', { type: 'spouse', personId: treeA.rootId });
    await storageService.saveFamilyTree(updatedTreeA);
    const photoAfter = (await storageService.loadPhotos())[0];
    window.showDirectoryPicker = async () => folderB;
    if (!await storageService.connectFileSystem()) throw new Error('Could not connect second test folder');
    const secondFolder = await storageService.loadFamilyTree();
    window.showDirectoryPicker = async () => folderA;
    await storageService.connectFileSystem();
    const restoredTreeA = await storageService.loadFamilyTree();
    storageService.saveSettings({ language: 'en', storageType: 'local' });
    return { initiallyEmpty, secondFolder, restoredTreeA, updatedTreeA, photoAfter, local: await storageService.loadFamilyTree() };
  });
  expect(result.initiallyEmpty.people).toEqual([]);
  expect(result.secondFolder.people).toEqual([]);
  expect(result.restoredTreeA).toEqual(result.updatedTreeA);
  expect(result.photoAfter.description).toBe('Preserved photo');
  expect(result.photoAfter.people).toEqual(['Photo person']);
  expect(result.local).toEqual(localTree);
});

test('failed relationship saves report the problem and keep the saved tree intact', async ({ page }) => {
  await seedPhoto(page);
  await startTree(page);
  const before = await storedTree(page);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('Denied', 'QuotaExceededError'); };
  });
  await page.getByRole('button', { name: 'Add spouse', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill('Unsaved spouse');
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/save|saved/i);
  await page.reload();
  await openTree(page);
  expect(await storedTree(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Select Unsaved spouse', exact: true })).toHaveCount(0);
});

test('relationship validation rejects cycles, duplicate spouses, and third parents without mutating the tree', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { emptyFamilyTree, addFamilyMember } = await import('/utils/familyTree.ts');
    let tree = addFamilyMember(emptyFamilyTree(), 'Mária', { type: 'self' });
    tree = addFamilyMember(tree, 'Peter', { type: 'spouse', personId: tree.rootId });
    tree = addFamilyMember(tree, 'Anna', { type: 'parent', personId: tree.rootId });
    tree = addFamilyMember(tree, 'Jozef', { type: 'parent', personId: tree.rootId });
    const before = JSON.stringify(tree);
    const attempt = (name, type) => {
      try { addFamilyMember(tree, name, { type, personId: tree.rootId }); return 'accepted'; }
      catch (error) { return error.code; }
    };
    return {
      selfParent: attempt('  mária  ', 'parent'),
      selfChild: attempt('Mária', 'child'),
      sameSpouse: attempt(' peter ', 'spouse'),
      secondSpouse: attempt('Another spouse', 'spouse'),
      thirdParent: attempt('Another parent', 'parent'),
      emptyName: attempt('   ', 'child'),
      unchanged: JSON.stringify(tree) === before,
    };
  });
  expect(result).toEqual({
    selfParent: 'cycle', selfChild: 'cycle', sameSpouse: 'duplicateRelation', secondSpouse: 'spouseLimit',
    thirdParent: 'parentLimit', emptyName: 'invalidName', unchanged: true,
  });
});




test('a corrupt saved tree blocks editing, reports load failure, and survives retry unchanged', async ({ page }) => {
  await seedPhoto(page);
  const corrupt = { rootId: 'missing-person', people: [{ id: 'saved-person', name: 'Saved name' }], families: [] };
  await page.evaluate(async corrupt => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ancestry-lens-family-tree', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('tree', 'readwrite');
        transaction.objectStore('tree').put(corrupt, 'familyTree');
        transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }, corrupt);
  await page.reload();
  await openTree(page);
  await expect(page.getByRole('alert')).toContainText('The family tree could not be loaded');
  await expect(page.getByRole('button', { name: 'Start my tree', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add parent', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The family tree could not be loaded');
  const stillStored = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ancestry-lens-family-tree', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('tree', 'readonly');
        const request = transaction.objectStore('tree').get('familyTree');
        transaction.oncomplete = () => resolve(request.result); transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  });
  expect(stillStored).toEqual(corrupt);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Family tree test memory', exact: true })).toBeVisible();
});

test('the tree setup, relationship dialog, and zoom controls work in Slovak', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ ...storageService.getSettings(), language: 'sk' });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Rodokmeň', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Začnite sebou', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Vaše meno', exact: true }).fill('Filip');
  await page.getByRole('button', { name: 'Vytvoriť môj rodokmeň', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Vybrať Filip', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Priblížiť', exact: true }).click();
  await expect.poll(async () => Number(await page.getByTestId('family-tree-canvas').getAttribute('data-scale'))).toBeGreaterThan(0.9);
  await page.getByRole('button', { name: 'Pridať manžela/manželku', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pridať manžela/manželku', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Nové mená budú dostupné aj pri označovaní fotografií.');
  await dialog.getByRole('button', { name: 'Zavrieť', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});


test('Fit tree contains a wide family on desktop and mobile below twenty percent zoom', async ({ page }) => {
  await page.goto('/');
  const names = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const { emptyFamilyTree, addFamilyMember } = await import('/utils/familyTree.ts');
    let tree = addFamilyMember(emptyFamilyTree(), 'Wide family root', { type: 'self' });
    tree = addFamilyMember(tree, 'Root spouse', { type: 'spouse', personId: tree.rootId });
    for (let index = 1; index <= 12; index++) {
      const childName = `Child ${index}`;
      tree = addFamilyMember(tree, childName, { type: 'child', personId: tree.rootId });
      const child = tree.people.find(person => person.name === childName);
      tree = addFamilyMember(tree, `Partner ${index}`, { type: 'spouse', personId: child.id });
    }
    await storageService.saveFamilyTree(tree);
    return tree.people.map(person => person.name);
  });
  await page.reload();
  await openTree(page);
  const canvas = page.getByTestId('family-tree-canvas');
  const assertAllCardsFit = async () => {
    await page.getByRole('button', { name: 'Fit tree', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const viewport = await canvas.boundingBox();
    expect(Number(await canvas.getAttribute('data-scale'))).toBeLessThan(0.2);
    for (const name of names) {
      const card = await page.getByRole('button', { name: `Select ${name}`, exact: true }).boundingBox();
      expect(card.x, name).toBeGreaterThanOrEqual(viewport.x);
      expect(card.y, name).toBeGreaterThanOrEqual(viewport.y);
      expect(card.x + card.width, name).toBeLessThanOrEqual(viewport.x + viewport.width);
      expect(card.y + card.height, name).toBeLessThanOrEqual(viewport.y + viewport.height);
    }
  };
  await assertAllCardsFit();
  await page.setViewportSize({ width: 390, height: 844 });
  await assertAllCardsFit();
});
