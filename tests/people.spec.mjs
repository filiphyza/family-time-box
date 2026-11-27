import { test, expect } from '@playwright/test';

async function seed(page, folder = false) {
  await page.goto('/');
  await page.evaluate(async folder => {
    const { storageService } = await import('/services/storageService.ts');
    if (folder) {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getDirectoryHandle('people-test-archive', { create: true });
      window.showDirectoryPicker = async () => handle;
      storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
      if (!await storageService.connectFileSystem()) throw new Error('Could not connect test archive');
    }
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext('2d'); context.fillStyle = '#687b8d'; context.fillRect(0, 0, 600, 400);
    for (let index = 1; index <= 3; index++) {
      await storageService.savePhoto({
        id: `people-${index}`, fileName: `photo-${index}.png`, originalUrl: canvas.toDataURL(), uploadDate: index,
        description: `Test memory ${index}`, people: [], tags: [], dateOfPhoto: '', isRestoring: false,
        faceTags: index === 3 ? [{ id: 'legacy-face', name: 'Mária', x: 30, y: 30 }] : [],
      });
    }
  }, folder);
  await page.reload();
  await expect(page.getByRole('img', { name: 'Test memory 1', exact: true })).toBeVisible();
}

async function edit(page, index) {
  await page.getByRole('img', { name: `Test memory ${index}`, exact: true }).click();
  if (await page.getByRole('switch', { name: 'Edit mode', exact: true }).getAttribute('aria-checked') !== 'true') {
    await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  }
  return page.getByRole('dialog', { name: 'Photo Details', exact: true });
}

async function stored(page, id) {
  return page.evaluate(async id => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    return (await storageService.loadPhotos()).find(photo => photo.id === id);
  }, id);
}

test('Add person creates a name, offers it on another photo, and preserves it after reload', async ({ page }) => {
  await seed(page);
  let dialog = await edit(page, 1);
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill('  Anna   Nováková  ');
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove person: Anna Nováková', exact: true })).toBeVisible();
  expect((await stored(page, 'people-1')).people).toEqual(['Anna Nováková']);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  dialog = await edit(page, 2);
  // Clicking Add person with an empty field opens the existing people picker.
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await dialog.getByRole('option', { name: 'Anna Nováková', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove person: Anna Nováková', exact: true })).toBeVisible();
  expect((await stored(page, 'people-2')).people).toEqual(['Anna Nováková']);
  await page.reload();
  dialog = await edit(page, 2);
  await expect(dialog.getByRole('button', { name: 'Remove person: Anna Nováková', exact: true })).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill('anna nováková');
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'already added' })).toContainText('already added');
  expect((await stored(page, 'people-2')).people).toEqual(['Anna Nováková']);
});

test('names in older face tags are reusable with keyboard selection', async ({ page }) => {
  await seed(page);
  const dialog = await edit(page, 1);
  const input = dialog.getByRole('combobox', { name: 'Person name', exact: true });
  await input.fill('már');
  await expect(dialog.getByRole('option', { name: 'Mária', exact: true })).toBeVisible();
  await input.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Remove person: Mária', exact: true })).toBeVisible();
  expect((await stored(page, 'people-1')).people).toEqual(['Mária']);
});

test('face tagging reuses an archive name and confirmation closes the picker near image edges', async ({ page }) => {
  await seed(page);
  const dialog = await edit(page, 2);
  await dialog.getByRole('button', { name: 'Tag People', exact: true }).click();
  const image = dialog.getByRole('img', { name: 'Main view', exact: true });
  const bounds = await image.boundingBox();
  await image.click({ position: { x: bounds.width * 0.95, y: bounds.height * 0.85 } });
  const faceInput = dialog.getByRole('combobox', { name: 'Who is this?', exact: true });
  await expect(faceInput).toBeFocused();
  await dialog.getByRole('option', { name: 'Mária', exact: true }).click();
  await expect(faceInput).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Tag People', exact: true })).toHaveAttribute('aria-pressed', 'true');
  let photo = await stored(page, 'people-2');
  expect(photo.people).toEqual(['Mária']);
  expect(photo.faceTags).toHaveLength(1);
  expect(photo.faceTags[0].name).toBe('Mária');
  expect(photo.faceTags[0].x).toBeCloseTo(95, 0);
  // Continue tagging another face without toggling the arrow again.
  await image.click({ position: { x: bounds.width * 0.3, y: bounds.height * 0.3 } });
  await faceInput.fill('Peter');
  await dialog.getByRole('button', { name: 'Tag person', exact: true }).click();
  await expect(faceInput).toHaveCount(0);
  photo = await stored(page, 'people-2');
  expect(photo.faceTags.map(tag => tag.name)).toEqual(['Mária', 'Peter']);
  await dialog.getByRole('button', { name: 'Remove person: Mária', exact: true }).click();
  photo = await stored(page, 'people-2');
  expect(photo.people).toEqual(['Peter']);
  expect(photo.faceTags.map(tag => tag.name)).toEqual(['Peter']);
});

test('people edits in a connected folder survive refresh and rapid writes preserve other photos', async ({ page }) => {
  await seed(page, true);
  const dialog = await edit(page, 1);
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill('Anna');
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect.poll(async () => (await stored(page, 'people-1')).people).toEqual(['Anna']);
  const people = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    const photos = await storageService.loadPhotos();
    const first = photos.find(photo => photo.id === 'people-1');
    const second = photos.find(photo => photo.id === 'people-2');
    const getFile = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = async function () {
      const file = await getFile.call(this);
      if (this.name === 'ancestry_db.json') await new Promise(resolve => setTimeout(resolve, 15));
      return file;
    };
    try {
      await Promise.all([
        storageService.savePhoto({ ...first, people: ['Anna', 'Peter'] }),
        storageService.savePhoto({ ...second, people: ['Mária'] }),
        storageService.savePhoto({ ...first, people: ['Anna', 'Peter', 'Ján'] }),
      ]);
      return (await storageService.loadPhotos()).map(photo => ({ id: photo.id, people: photo.people }));
    } finally { FileSystemFileHandle.prototype.getFile = getFile; }
  });
  expect(people.find(photo => photo.id === 'people-1').people).toEqual(['Anna', 'Peter', 'Ján']);
  expect(people.find(photo => photo.id === 'people-2').people).toEqual(['Mária']);
  await page.reload();
  const reloaded = await edit(page, 2);
  await reloaded.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(reloaded.getByRole('option', { name: 'Anna', exact: true })).toBeVisible();
  await reloaded.getByRole('option', { name: 'Anna', exact: true }).click();
  await expect(reloaded.getByRole('button', { name: 'Remove person: Anna', exact: true })).toBeVisible();
});

test('a failed save is visible inside the editor', async ({ page }) => {
  await seed(page);
  const dialog = await edit(page, 1);
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Denied', 'QuotaExceededError'); }; });
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill('Anna');
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Changes could not be saved');
});

test('AI restoration cannot erase people added while it is running', async ({ page }) => {
  await seed(page);
  let request;
  await page.route('https://generativelanguage.googleapis.com/**', route => { request = route; });
  const dialog = await edit(page, 1);
  await dialog.getByRole('button', { name: 'Restore & Colorize', exact: true }).click();
  await expect.poll(() => Boolean(request)).toBe(true);
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill('Anna');
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove person: Anna', exact: true })).toBeVisible();
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    return canvas.toDataURL().split(',')[1];
  });
  await request.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: base64 } }] } }] }) });
  await expect(dialog.getByRole('button', { name: 'Re-Restore', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Remove person: Anna', exact: true })).toBeVisible();
  expect((await stored(page, 'people-1')).people).toEqual(['Anna']);
});

test('AI restoration retains edits after navigating away and returning', async ({ page }) => {
  await seed(page);
  let request;
  await page.route('https://generativelanguage.googleapis.com/**', route => { request = route; });
  const dialog = await edit(page, 2);
  await dialog.getByRole('button', { name: 'Restore & Colorize', exact: true }).click();
  await expect.poll(() => Boolean(request)).toBe(true);

  await page.mouse.move(page.viewportSize().width - 5, page.viewportSize().height / 2);
  await dialog.getByRole('button', { name: 'Next photo', exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue('Test memory 1');
  await page.mouse.move(5, page.viewportSize().height / 2);
  await dialog.getByRole('button', { name: 'Previous photo', exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue('Test memory 2');
  await dialog.getByRole('combobox', { name: 'Person name', exact: true }).fill('Anna');
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await dialog.locator('textarea').fill('Edited after returning to the photo');
  await expect(dialog.getByRole('button', { name: 'Remove person: Anna', exact: true })).toBeVisible();

  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    return canvas.toDataURL().split(',')[1];
  });
  await request.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: base64 } }] } }] }) });
  await expect(dialog.getByRole('button', { name: 'Re-Restore', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Remove person: Anna', exact: true })).toBeVisible();
  await expect(dialog.locator('textarea')).toHaveValue('Edited after returning to the photo');
  const original = await stored(page, 'people-2');
  expect(original.people).toEqual(['Anna']);
  expect(original.description).toBe('Edited after returning to the photo');
  expect(original.restoredUrl).toBeTruthy();
  expect(original.isRestoring).toBe(false);
  const other = await stored(page, 'people-1');
  expect(other.people).toEqual([]);
  expect(other.description).toBe('Test memory 1');
  expect(other.restoredUrl).toBeUndefined();
});

