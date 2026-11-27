import { test, expect } from '@playwright/test';

async function seed(page, storageType = 'local', language = 'en') {
  await page.goto('/');
  await page.evaluate(async ({ storageType, language }) => {
    const { storageService } = await import('/services/storageService.ts');
    const { emptyFamilyTree, addFamilyMember } = await import('/utils/familyTree.ts');
    storageService.saveSettings({ language, storageType });
    if (storageType === 'filesystem') {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('avatar-test-archive', { create: true });
      window.showDirectoryPicker = async () => folder;
      if (!await storageService.connectFileSystem()) throw new Error('Could not connect the test archive.');
    }
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext('2d');
    for (const [index, record] of [
      { id: 'face-only', fileName: 'portrait.png', people: [], faceTags: [{ id: 'anna-face', name: ' ANNA ', x: 92, y: 8 }] },
      { id: 'people-only', fileName: 'holiday.png', people: [' anna '], faceTags: [] },
      { id: 'other-person', fileName: 'someone-else.png', people: ['Other person'], faceTags: [] },
      { id: 'untagged', fileName: 'landscape.png', people: [], faceTags: [] },
    ].entries()) {
      context.fillStyle = ['#745e44', '#245d6b', '#657331', '#6c4966'][index]; context.fillRect(0, 0, 600, 400);
      context.fillStyle = '#f0c498'; context.beginPath(); context.arc(552, 32, 24, 0, Math.PI * 2); context.fill();
      await storageService.savePhoto({ ...record, originalUrl: canvas.toDataURL(), uploadDate: index + 1, description: record.fileName, tags: [], dateOfPhoto: '', isRestoring: false });
    }
    let tree = addFamilyMember(emptyFamilyTree(), 'Anna', { type: 'self' });
    tree = addFamilyMember(tree, 'Peter', { type: 'spouse', personId: tree.rootId });
    await storageService.saveFamilyTree(tree);
  }, { storageType, language });
  await page.reload();
  await page.getByRole('button', { name: language === 'sk' ? 'Rodokmeň' : 'Family tree', exact: true }).click();
  await expect(page.getByTestId('family-tree-canvas')).toBeVisible();
}

async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    return storageService.loadFamilyTree();
  });
}
async function openPicker(page, name = 'Anna') {
  if (!await page.getByRole('button', { name: `Change avatar for ${name}`, exact: true }).isVisible()) await page.getByRole('button', { name: `Select ${name}`, exact: true }).click();
  await page.getByRole('button', { name: `Change avatar for ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose avatar', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function choose(page, fileName = 'portrait.png') {
  const dialog = page.getByRole('dialog', { name: 'Choose avatar', exact: true });
  await dialog.getByRole('button', { name: `Use photo: ${fileName}`, exact: true }).click();
  await dialog.getByRole('button', { name: 'Save avatar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

for (const storageType of ['local', 'filesystem']) {
  test(`avatar picker uses only tagged photos and survives edits and reload in ${storageType} storage`, async ({ page }) => {
    await seed(page, storageType);
    const rootCard = page.getByRole('button', { name: 'Select Anna', exact: true });
    const dialog = await openPicker(page);
    const transform = await page.locator('.ft-world').getAttribute('style');
    await expect(dialog.getByRole('button', { name: /^Use photo:/ })).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: 'Use photo: portrait.png', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Use photo: holiday.png', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /someone-else|landscape/ })).toHaveCount(0);
    await choose(page);
    await expect(rootCard.locator('.ft-portrait')).toHaveAttribute('data-photo-id', 'face-only');
    await expect(page.locator('.ft-avatar-button .ft-portrait')).toHaveAttribute('data-photo-id', 'face-only');
    await expect.poll(async () => rootCard.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await page.locator('.ft-world').getAttribute('style')).toBe(transform);
    const tree = await stored(page);
    expect(tree.people.find(person => person.id === tree.rootId).avatarPhotoId).toBe('face-only');
    expect(JSON.stringify(tree)).not.toMatch(/blob:|data:image/);
    const originalSource = await rootCard.locator('img').getAttribute('src');
    const verification = await page.evaluate(async () => {
      const { storageService } = await import('/services/storageService.ts');
      const { addFamilyMember } = await import('/utils/familyTree.ts');
      const tree = await storageService.loadFamilyTree();
      await storageService.saveFamilyTree(addFamilyMember(tree, 'Mother', { type: 'parent', personId: tree.rootId }));
      const photo = (await storageService.loadPhotos()).find(photo => photo.id === 'face-only');
      if (storageService.getSettings().storageType === 'filesystem') {
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle('avatar-test-archive');
        const file = await (await folder.getFileHandle('ancestry_family_tree.json')).getFile();
        const data = await file.text();
        if (/blob:|data:image/.test(data)) throw new Error('An ephemeral image URL leaked into the saved tree.');
      }
      return { people: photo.people, faceTags: photo.faceTags };
    });
    expect(verification).toEqual({ people: [], faceTags: [{ id: 'anna-face', name: ' ANNA ', x: 92, y: 8 }] });
    await page.reload();
    await page.getByRole('button', { name: 'Family tree', exact: true }).click();
    await expect(rootCard.locator('.ft-portrait')).toHaveAttribute('data-photo-id', 'face-only');
    await expect.poll(async () => rootCard.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    if (storageType === 'filesystem') expect(await rootCard.locator('img').getAttribute('src')).not.toBe(originalSource);
    const reopened = await openPicker(page);
    await expect(reopened.getByRole('button', { name: 'Use photo: portrait.png', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await choose(page, 'holiday.png');
    await expect(rootCard.locator('.ft-portrait')).toHaveAttribute('data-photo-id', 'people-only');
    await openPicker(page);
    await page.getByRole('button', { name: 'Use initials', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(rootCard.locator('.ft-portrait')).toHaveText('A');
    await page.reload();
    expect((await stored(page)).people.find(person => person.name === 'Anna')).not.toHaveProperty('avatarPhotoId');
  });
}

test('failed avatar saves keep the existing avatar and can be retried', async ({ page }) => {
  await seed(page);
  await openPicker(page);
  await choose(page);
  await page.evaluate(() => {
    window.realAvatarPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test denied', 'QuotaExceededError'); };
  });
  const dialog = await openPicker(page);
  await dialog.getByRole('button', { name: 'Use photo: holiday.png', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save avatar', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be saved');
  await dialog.getByRole('button', { name: 'Choose another photo', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Use photo: portrait.png', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await stored(page)).people.find(person => person.name === 'Anna').avatarPhotoId).toBe('face-only');
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.realAvatarPut; });
  await choose(page, 'holiday.png');
  await expect(page.getByRole('button', { name: 'Select Anna', exact: true }).locator('.ft-portrait')).toHaveAttribute('data-photo-id', 'people-only');
});

test('mobile drawer avatar opens a localized empty state and cancellation restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, 'local', 'sk');
  await page.getByRole('button', { name: 'Zobraziť celý rodokmeň', exact: true }).click();
  await page.getByRole('button', { name: 'Vybrať Peter', exact: true }).click();
  const opener = page.getByRole('button', { name: 'Zmeniť portrét osoby Peter', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Vybrať portrét', exact: true });
  await expect(dialog).toContainText('Zatiaľ žiadne označené fotografie.');
  await expect(dialog.getByRole('button', { name: /^Použiť fotografiu:/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Použiť iniciály', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect((await stored(page)).people.find(person => person.name === 'Peter')).not.toHaveProperty('avatarPhotoId');
});

test('removing an avatar photo keeps the tree usable and falls back to initials', async ({ page }) => {
  await seed(page);
  await openPicker(page);
  await choose(page);
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    await storageService.deletePhoto('face-only');
  });
  await page.reload();
  await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  const rootCard = page.getByRole('button', { name: 'Select Anna', exact: true });
  await expect(rootCard.locator('.ft-portrait')).toHaveText('A');
  await expect(rootCard.locator('img')).toHaveCount(0);
  const dialog = await openPicker(page);
  await expect(dialog.getByRole('button', { name: /^Use photo:/ })).toHaveCount(1);
  await choose(page, 'holiday.png');
  await expect(rootCard.locator('.ft-portrait')).toHaveAttribute('data-photo-id', 'people-only');
});

for (const storageType of ['local', 'filesystem']) {
  test(`avatar zoom and crop persist without changing photo tags in ${storageType}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seed(page, storageType);
    let dialog = await openPicker(page);
    await dialog.getByRole('button', { name: 'Use photo: portrait.png', exact: true }).click();
    await expect(dialog.getByRole('slider', { name: 'Zoom', exact: true })).toHaveValue('2.5');
    await dialog.getByRole('slider', { name: 'Zoom', exact: true }).fill('8');
    await dialog.getByRole('slider', { name: 'Horizontal position', exact: true }).fill('87');
    await dialog.getByRole('slider', { name: 'Vertical position', exact: true }).fill('12');
    await expect.poll(() => dialog.locator('.ft-avatar-crop-preview img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    const previewStyle = await dialog.locator('.ft-avatar-crop-preview img').getAttribute('style');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `test-results/avatar-crop-${storageType}.png` });
    await dialog.getByRole('button', { name: 'Save avatar', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    let person = (await stored(page)).people.find(person => person.name === 'Anna');
    expect(person.avatarCrop).toEqual({ x: 87, y: 12, zoom: 8 });
    await page.reload();
    await page.getByRole('button', { name: 'Family tree', exact: true }).click();
    const avatar = page.getByRole('button', { name: 'Select Anna', exact: true }).locator('img');
    await expect(avatar).toHaveAttribute('style', previewStyle);
    dialog = await openPicker(page);
    await dialog.getByRole('button', { name: 'Use photo: portrait.png', exact: true }).click();
    await expect(dialog.getByRole('slider', { name: 'Zoom', exact: true })).toHaveValue('8');
    await dialog.getByRole('button', { name: 'Reset crop', exact: true }).click();
    await expect(dialog.getByRole('slider', { name: 'Zoom', exact: true })).toHaveValue('2.5');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    person = (await stored(page)).people.find(person => person.name === 'Anna');
    expect(person.avatarCrop).toEqual({ x: 87, y: 12, zoom: 8 });
    await openPicker(page);
    await page.getByRole('button', { name: 'Use initials', exact: true }).click();
    person = (await stored(page)).people.find(person => person.name === 'Anna');
    expect(person).not.toHaveProperty('avatarCrop');
    expect(person).not.toHaveProperty('avatarPhotoId');
  });
}
