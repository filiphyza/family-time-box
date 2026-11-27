import { test, expect } from '@playwright/test';

async function seed(page, { date = '1976-08-14', folder = false, language = 'en' } = {}) {
  await page.goto('/');
  await page.evaluate(async ({ date, folder, language }) => {
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ language, storageType: folder ? 'filesystem' : 'local' });
    if (folder) {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('photo-partial-date-archive', { create: true });
      window.showDirectoryPicker = async () => archive;
      if (!await storageService.connectFileSystem()) throw new Error('Test archive unavailable');
    }
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
    canvas.getContext('2d').fillRect(0, 0, 80, 60);
    await storageService.savePhoto({ id: 'dated-photo', fileName: 'family.tif', originalUrl: canvas.toDataURL(),
      uploadDate: 123456, description: 'A dated family photo', location: 'Garden', dateOfPhoto: date,
      people: ['Anna'], tags: ['family'], faceTags: [{ id: 'anna-face', name: 'Anna', x: 40, y: 50 }], isRestoring: false });
  }, { date, folder, language });
  await page.reload();
  await page.getByRole('img', { name: 'A dated family photo', exact: true }).click();
  await page.getByRole('button', { name: language === 'en' ? 'Enhance / Edit' : 'Vylepšiť / Upraviť', exact: true }).click();
  return page.getByRole('dialog', { name: language === 'en' ? 'Photo Details' : 'Detaily fotky', exact: true });
}

async function savedDate(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    return (await storageService.loadPhotos())[0].dateOfPhoto;
  });
}

for (const folder of [false, true]) {
  test(`photo precision saves only known parts and survives reload (${folder ? 'folder' : 'browser'})`, async ({ page }) => {
    const editor = await seed(page, { folder });
    const precision = editor.getByRole('combobox', { name: 'Date Taken precision', exact: true });
    await expect(precision).toHaveValue('date');
    await precision.selectOption('month');
    await expect.poll(() => savedDate(page)).toBe('1976-08');
    await expect(editor.getByRole('spinbutton', { name: 'Date Taken day', exact: true })).toHaveCount(0);
    await precision.selectOption('year');
    await editor.getByRole('spinbutton', { name: 'Date Taken year', exact: true }).fill('1984');
    await expect.poll(() => savedDate(page)).toBe('1984');
    await page.reload();
    await page.getByRole('img', { name: 'A dated family photo', exact: true }).click();
    await expect(page.getByRole('heading', { name: '1984', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
    await expect(precision).toHaveValue('year');
    await precision.selectOption('month');
    await editor.getByRole('combobox', { name: 'Date Taken month', exact: true }).selectOption('2');
    await expect.poll(() => savedDate(page)).toBe('1984-02');
    await editor.getByRole('button', { name: 'View mode', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'February 1984', exact: true })).toBeVisible();
  });
}

test('incomplete and impossible calendar dates keep the last valid value', async ({ page }) => {
  const editor = await seed(page, { date: '2000-02-29' });
  const year = editor.getByRole('spinbutton', { name: 'Date Taken year', exact: true });
  await year.fill('1900');
  await expect(editor.getByRole('alert')).toContainText('Enter a valid date');
  expect(await savedDate(page)).toBe('2000-02-29');
  await editor.getByRole('spinbutton', { name: 'Date Taken day', exact: true }).fill('28');
  await expect.poll(() => savedDate(page)).toBe('1900-02-28');
  await expect(editor.getByRole('alert')).toHaveCount(0);
  await year.fill('');
  await expect(editor.getByRole('alert')).toContainText('Enter a valid date');
  expect(await savedDate(page)).toBe('1900-02-28');
  await editor.getByRole('combobox', { name: 'Date Taken precision', exact: true }).selectOption('none');
  await expect.poll(() => savedDate(page)).toBe('');
  await expect(editor.getByRole('alert')).toHaveCount(0);
});

test('unknown dates can become month dates without inventing a day', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const editor = await seed(page, { date: '' });
  await editor.getByRole('combobox', { name: 'Date Taken precision', exact: true }).selectOption('month');
  await editor.getByRole('spinbutton', { name: 'Date Taken year', exact: true }).fill('1965');
  expect(await savedDate(page)).toBe('');
  await editor.getByRole('combobox', { name: 'Date Taken month', exact: true }).selectOption('12');
  await expect.poll(() => savedDate(page)).toBe('1965-12');
  await editor.getByRole('combobox', { name: 'Date Taken month', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('photo-month-year-mobile.png') });
  await editor.getByRole('combobox', { name: 'Date Taken precision', exact: true }).selectOption('date');
  expect(await savedDate(page)).toBe('1965-12');
  await editor.getByRole('spinbutton', { name: 'Date Taken day', exact: true }).fill('24');
  await expect.poll(() => savedDate(page)).toBe('1965-12-24');
});

test('precision toggles preserve local date parts and reject out-of-range years', async ({ page }) => {
  const editor = await seed(page);
  const precision = editor.getByRole('combobox', { name: 'Date Taken precision', exact: true });
  await precision.selectOption('year');
  await expect.poll(() => savedDate(page)).toBe('1976');
  await precision.selectOption('month');
  await expect(editor.getByRole('combobox', { name: 'Date Taken month', exact: true })).toHaveValue('8');
  await expect.poll(() => savedDate(page)).toBe('1976-08');
  await precision.selectOption('date');
  await expect(editor.getByRole('spinbutton', { name: 'Date Taken day', exact: true })).toHaveValue('14');
  await expect.poll(() => savedDate(page)).toBe('1976-08-14');
  const year = editor.getByRole('spinbutton', { name: 'Date Taken year', exact: true });
  for (const invalid of ['10000', '0', '-1']) {
    await year.fill(invalid);
    await expect(editor.getByRole('alert')).toContainText('Enter a valid date');
    expect(await savedDate(page)).toBe('1976-08-14');
  }
  await year.fill('1984');
  await expect.poll(() => savedDate(page)).toBe('1984-08-14');
  await editor.getByRole('spinbutton', { name: 'Date Taken day', exact: true }).fill('31');
  await editor.getByRole('combobox', { name: 'Date Taken month', exact: true }).selectOption('2');
  await expect(editor.getByRole('alert')).toBeVisible();
  expect(await savedDate(page)).toBe('1984-08-31');
  await precision.selectOption('year');
  await expect.poll(() => savedDate(page)).toBe('1984');
  await precision.selectOption('month');
  await expect.poll(() => savedDate(page)).toBe('1984-02');
  await precision.selectOption('date');
  await expect(editor.getByRole('spinbutton', { name: 'Date Taken day', exact: true })).toHaveValue('31');
  await expect(editor.getByRole('alert')).toBeVisible();
  expect(await savedDate(page)).toBe('1984-02');
});
