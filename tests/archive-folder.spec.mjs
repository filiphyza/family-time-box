import { test, expect } from '@playwright/test';

async function selectArchive(page) {
  await page.goto('/');
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getDirectoryHandle('test-archive', { create: true });
    // A real, serializable directory handle exercises IndexedDB persistence.
    window.showDirectoryPicker = async () => handle;
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
    if (!await storageService.connectFileSystem()) throw new Error('Could not select test archive');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    await storageService.savePhoto({ id: 'persisted', fileName: 'photo.png', originalUrl: canvas.toDataURL(), uploadDate: 1, description: 'Persisted archive photo', people: [], tags: [], faceTags: [], dateOfPhoto: '', isRestoring: false });
    const { loadArchiveHandle } = await import('/services/archiveFolder.ts');
    return (await loadArchiveHandle()).name;
  });
}

test('authorized folder and its photos reconnect automatically after repeated refreshes', async ({ page }) => {
  expect(await selectArchive(page)).toBe('test-archive');
  for (let refresh = 0; refresh < 2; refresh++) {
    await page.reload();
    await expect(page.getByRole('img', { name: 'Persisted archive photo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect Drive', exact: true })).toHaveCount(0);
  }
});

test('permission prompt requires a click and reuses the saved folder without a picker', async ({ page }) => {
  await selectArchive(page);
  await page.addInitScript(() => {
    Object.defineProperty(FileSystemHandle.prototype, 'queryPermission', { configurable: true, value: async () => sessionStorage.getItem('test-allowed') === 'yes' ? 'granted' : 'prompt' });
    Object.defineProperty(FileSystemHandle.prototype, 'requestPermission', { configurable: true, value: async () => {
      sessionStorage.setItem('test-requests', String(Number(sessionStorage.getItem('test-requests') || 0) + 1));
      sessionStorage.setItem('test-allowed', 'yes');
      return 'granted';
    } });
    window.showDirectoryPicker = async () => { throw new Error('A saved folder must not require a picker'); };
  });
  await page.reload();
  const reconnect = page.getByRole('button', { name: 'Reconnect Drive', exact: true });
  await expect(reconnect).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('test-requests'))).toBeNull();
  await reconnect.click();
  await expect(page.getByRole('img', { name: 'Persisted archive photo' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('test-requests'))).toBe('1');
  await page.reload();
  await expect(page.getByRole('img', { name: 'Persisted archive photo' })).toBeVisible();
});

test('denied permission keeps reconnection visible and never opens another picker', async ({ page }) => {
  await selectArchive(page);
  await page.addInitScript(() => {
    Object.defineProperty(FileSystemHandle.prototype, 'queryPermission', { configurable: true, value: async () => 'denied' });
    Object.defineProperty(FileSystemHandle.prototype, 'requestPermission', { configurable: true, value: async () => 'denied' });
    window.showDirectoryPicker = async () => { sessionStorage.setItem('unexpected-picker', 'yes'); throw new Error('Unexpected picker'); };
  });
  await page.reload();
  const reconnect = page.getByRole('button', { name: 'Reconnect Drive', exact: true });
  await expect(reconnect).toBeVisible();
  await reconnect.click();
  await expect(reconnect).toBeVisible();
  await expect(page.getByRole('img', { name: 'Persisted archive photo' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('unexpected-picker'))).toBeNull();
});

test('failed folder access cannot leave a falsely connected handle', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    window.showDirectoryPicker = async () => ({ getDirectoryHandle: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
    return { selected: await storageService.connectFileSystem(), connected: storageService.isFileSystemConnected() };
  });
  expect(result).toEqual({ selected: false, connected: false });
});
