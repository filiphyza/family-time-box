import { test, expect } from '@playwright/test';

async function seed(page, folder = false) {
  await page.goto('/');
  await page.evaluate(async folder => {
    const { storageService } = await import('/services/storageService.ts');
    if (folder) {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getDirectoryHandle('delete-test-archive', { create: true });
      window.showDirectoryPicker = async () => handle;
      storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
      if (!await storageService.connectFileSystem()) throw new Error('Could not connect test archive');
    }
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
    for (let index = 1; index <= 2; index++) await storageService.savePhoto({
      id: `delete-${index}`, fileName: `photo-${index}.png`, originalUrl: canvas.toDataURL(), uploadDate: index,
      description: `Delete test ${index}`, people: ['Anna'], tags: ['family'], dateOfPhoto: '', isRestoring: false,
      faceTags: [{ id: `face-${index}`, name: 'Anna', x: 30, y: 30 }],
    });
  }, folder);
  await page.reload();
  await page.getByRole('img', { name: 'Delete test 1', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  return page.getByRole('dialog', { name: 'Photo Details', exact: true });
}

async function savedIds(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    return (await storageService.loadPhotos()).map(photo => photo.id).sort();
  });
}

test('cancelling deletion preserves the photo and its tags', async ({ page }) => {
  const editor = await seed(page);
  page.once('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('photo-1.png');
    expect(dialog.message()).toContain('Image files in connected folders or cloud storage are kept');
    await dialog.dismiss();
  });
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Remove person: Anna', exact: true })).toBeVisible();
  expect(await savedIds(page)).toEqual(['delete-1', 'delete-2']);
});

test('confirmed deletion survives reload even when an edit was queued first', async ({ page }) => {
  const editor = await seed(page);
  await editor.locator('textarea').fill('Updated just before deleting');
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Delete test 2', exact: true })).toBeVisible();
  expect(await savedIds(page)).toEqual(['delete-2']);
  await page.reload();
  await expect(page.getByRole('img', { name: 'Delete test 2', exact: true })).toBeVisible();
  expect(await savedIds(page)).toEqual(['delete-2']);
});

test('deleting from a connected folder removes only the archive record', async ({ page }) => {
  const editor = await seed(page, true);
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const disk = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const archive = await root.getDirectoryHandle('delete-test-archive');
    const database = JSON.parse(await (await (await archive.getFileHandle('ancestry_db.json')).getFile()).text());
    const images = await archive.getDirectoryHandle('images');
    const original = await (await images.getFileHandle('delete-1_original.png')).getFile();
    return { ids: database.map(photo => photo.id), retainedImageBytes: original.size };
  });
  expect(disk.ids).toEqual(['delete-2']);
  expect(disk.retainedImageBytes).toBeGreaterThan(0);
  await page.reload();
  expect(await savedIds(page)).toEqual(['delete-2']);
});

test('deletion errors keep the editor open and allow retry', async ({ page }) => {
  const editor = await seed(page);
  await page.evaluate(() => {
    window.originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function () { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('The photo could not be deleted');
  await expect(editor.getByRole('button', { name: 'Delete photo', exact: true })).toBeEnabled();
  expect(await savedIds(page)).toEqual(['delete-1', 'delete-2']);
  await page.evaluate(() => { IDBObjectStore.prototype.delete = window.originalDelete; });
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await savedIds(page)).toEqual(['delete-2']);
});

test('a pending deletion shows busy feedback and disables editor controls', async ({ page }) => {
  const editor = await seed(page, true);
  await page.evaluate(() => {
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      if (this.name === 'ancestry_db.json') return new Promise(resolve => { window.releaseDeletion = () => create.apply(this, args).then(resolve); });
      return create.apply(this, args);
    };
  });
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: 'Delete photo', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.releaseDeletion));
  await expect(editor.getByRole('button', { name: 'Deleting photo…', exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await expect(editor.locator('textarea')).toBeDisabled();
  await page.evaluate(() => window.releaseDeletion());
  await expect(editor).toHaveCount(0);
  expect(await savedIds(page)).toEqual(['delete-2']);
});
