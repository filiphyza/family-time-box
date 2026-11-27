import { test, expect } from '@playwright/test';

async function seed(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ language: 'en', storageType: 'local' });
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext('2d');
    for (let index = 1; index <= 3; index++) {
      context.fillStyle = ['#695c43', '#436950', '#435469'][index - 1];
      context.fillRect(0, 0, canvas.width, canvas.height);
      await storageService.savePhoto({
        id: `navigation-${index}`, fileName: `photo-${index}.png`, originalUrl: canvas.toDataURL(), uploadDate: index,
        description: `Navigation memory ${index}`, location: `Location ${index}`, people: [],
        tags: index === 2 ? [] : ['selected'], faceTags: [], dateOfPhoto: '', isRestoring: false,
      });
    }
  });
  await page.reload();
  await expect(page.getByRole('img', { name: 'Navigation memory 3', exact: true })).toBeVisible();
}

const editor = page => page.getByRole('dialog', { name: 'Photo Details', exact: true });
const previous = page => page.getByRole('button', { name: 'Previous photo', exact: true });
const next = page => page.getByRole('button', { name: 'Next photo', exact: true });
const mode = page => page.getByRole('switch', { name: 'Edit mode', exact: true });
const position = page => page.getByLabel('Photo position', { exact: true });

async function navigate(page, direction) {
  const { width, height } = page.viewportSize();
  await page.mouse.move(direction === 'next' ? width - 5 : 5, height / 2);
  await (direction === 'next' ? next(page) : previous(page)).click();
}

async function expectHiddenArrows(page) {
  await expect(previous(page)).toHaveCSS('opacity', '0');
  await expect(next(page)).toHaveCSS('opacity', '0');
}

async function expectRevealed(control) {
  await expect.poll(() => control.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0.5);
}


async function open(page, index) {
  await page.getByRole('img', { name: `Navigation memory ${index}`, exact: true }).click();
}

async function stored(page, index) {
  return page.evaluate(async index => {
    const { storageService } = await import('/services/storageService.ts');
    return (await storageService.loadPhotos()).find(photo => photo.id === `navigation-${index}`);
  }, index);
}

test('central edit mode applies to every photo until switched back to viewing', async ({ page }) => {
  await seed(page);
  await expect(mode(page)).not.toBeChecked();
  await mode(page).click();
  await expect(mode(page)).toBeChecked();
  await open(page, 3);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 3');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(mode(page)).toBeChecked();
  await open(page, 2);
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 2');
  await editor(page).getByRole('button', { name: 'View mode', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enhance / Edit', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(mode(page)).not.toBeChecked();
  await open(page, 1);
  await expect(page.getByRole('button', { name: 'Enhance / Edit', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(mode(page)).toBeChecked();
  await open(page, 3);
  await expect(editor(page)).toBeVisible();
});

test('viewing supports buttons and arrow keys in gallery order with clear boundaries', async ({ page }) => {
  await seed(page);
  await open(page, 3);
  await expect(position(page)).toHaveText('1 / 3');
  await expect(previous(page)).toBeDisabled();
  await expect(next(page)).toBeEnabled();
  await navigate(page, 'next');
  await expect(position(page)).toHaveText('2 / 3');
  await expect(page.getByRole('img', { name: 'Navigation memory 2', exact: true }).last()).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(position(page)).toHaveText('3 / 3');
  await expect(page.getByRole('img', { name: 'Navigation memory 1', exact: true }).last()).toBeVisible();
  await expect(next(page)).toBeDisabled();
  await navigate(page, 'previous');
  await expect(position(page)).toHaveText('2 / 3');
  await page.keyboard.press('ArrowLeft');
  await expect(position(page)).toHaveText('1 / 3');
  await expect(previous(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Enhance / Edit', exact: true })).toBeVisible();
});

test('editor navigation keeps saved metadata and clears unsubmitted drafts between photos', async ({ page }) => {
  await seed(page);
  await mode(page).click();
  await open(page, 3);
  await editor(page).locator('textarea').fill('Edited while browsing');
  await editor(page).getByPlaceholder('Add tag (e.g. Vacation)...').fill('unsubmitted tag');
  await editor(page).getByRole('combobox', { name: 'Person name', exact: true }).fill('Unsubmitted person');
  await navigate(page, 'next');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 2');
  await expect(editor(page).getByPlaceholder('Add tag (e.g. Vacation)...')).toHaveValue('');
  await expect(editor(page).getByRole('combobox', { name: 'Person name', exact: true })).toHaveValue('');
  await expect(position(page)).toHaveText('2 / 3');
  await navigate(page, 'previous');
  await expect(editor(page).locator('textarea')).toHaveValue('Edited while browsing');
  await expect.poll(async () => (await stored(page, 3)).description).toBe('Edited while browsing');
  expect((await stored(page, 2)).description).toBe('Navigation memory 2');
  expect((await stored(page, 2)).tags).toEqual([]);
  expect((await stored(page, 2)).people).toEqual([]);
  await navigate(page, 'next');
  await navigate(page, 'next');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 1');
  await expect(next(page)).toBeDisabled();
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('img', { name: 'Edited while browsing', exact: true })).toBeVisible();
});

test('arrow keys edit fields without navigating and still navigate outside fields', async ({ page }) => {
  await seed(page);
  await mode(page).click();
  await open(page, 2);
  const description = editor(page).locator('textarea');
  await description.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(description).toHaveValue('Navigation memory 2');
  await expect(position(page)).toHaveText('2 / 3');
  const location = editor(page).locator('input[type="text"]').first();
  await location.focus();
  await page.keyboard.press('ArrowRight');
  await expect(position(page)).toHaveText('2 / 3');
  const person = editor(page).getByRole('combobox', { name: 'Person name', exact: true });
  await person.fill('Draft');
  await person.press('ArrowLeft');
  await expect(position(page)).toHaveText('2 / 3');
  await next(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 1');
  await previous(page).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 2');
});

test('both modes navigate only the filtered gallery and keep the current position when switching modes', async ({ page }) => {
  await seed(page);
  await page.locator('select').nth(1).selectOption('selected');
  await expect(page.getByRole('img', { name: 'Navigation memory 2', exact: true })).toHaveCount(0);
  await open(page, 3);
  await expect(position(page)).toHaveText('1 / 2');
  await navigate(page, 'next');
  await expect(position(page)).toHaveText('2 / 2');
  await expect(next(page)).toBeDisabled();
  await expect(page.getByRole('img', { name: 'Navigation memory 1', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 1');
  await expect(position(page)).toHaveText('2 / 2');
  await navigate(page, 'previous');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 3');
  await expect(previous(page)).toBeDisabled();
  await editor(page).getByRole('button', { name: 'View mode', exact: true }).click();
  await expect(position(page)).toHaveText('1 / 2');
});

test('edits do not reorder the open photo sequence or remove the current photo mid-edit', async ({ page }) => {
  await seed(page);
  await page.getByPlaceholder('Search memories, people, tags...').fill('Navigation memory');
  await mode(page).click();
  await open(page, 3);
  await editor(page).getByRole('combobox', { name: 'Date Taken precision', exact: true }).selectOption('date');
  await editor(page).getByRole('spinbutton', { name: 'Date Taken year', exact: true }).fill('1900');
  await editor(page).getByRole('combobox', { name: 'Date Taken month', exact: true }).selectOption('1');
  await editor(page).getByRole('spinbutton', { name: 'Date Taken day', exact: true }).fill('1');
  await navigate(page, 'next');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 2');
  await navigate(page, 'previous');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 3');
  await editor(page).locator('textarea').fill('Edited outside search results');
  await expect(position(page)).toHaveText('1 / 3');
  await navigate(page, 'next');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 2');
  await navigate(page, 'previous');
  await expect(editor(page).locator('textarea')).toHaveValue('Edited outside search results');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Edited outside search results', exact: true })).toHaveCount(0);
  await open(page, 2);
  await expect(position(page)).toHaveText('1 / 2');
  await navigate(page, 'next');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 1');
});

test('a delayed save failure belongs to the edited photo when navigating away and back', async ({ page }) => {
  await seed(page);
  await mode(page).click();
  await open(page, 3);
  await page.evaluate(async () => {
    // Reuse Vite's loaded module, including its HMR query, to patch the app's singleton.
    const moduleUrl = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/services/storageService.ts')?.name;
    const { storageService } = await import(moduleUrl || '/services/storageService.ts');
    const savePhoto = storageService.savePhoto.bind(storageService);
    storageService.savePhoto = photo => photo.id === 'navigation-3'
      ? new Promise((resolve, reject) => { window.rejectNavigationSave = () => reject(new DOMException('Test save failure', 'QuotaExceededError')); })
      : savePhoto(photo);
  });
  await editor(page).locator('textarea').fill('Unsaved change on photo 3');
  await page.waitForFunction(() => Boolean(window.rejectNavigationSave));
  await navigate(page, 'next');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 2');
  await page.evaluate(() => window.rejectNavigationSave());
  await expect(editor(page).getByRole('alert')).toHaveCount(0);
  await navigate(page, 'previous');
  await expect(editor(page).getByRole('alert')).toContainText('Changes could not be saved');
  await expect(editor(page).locator('textarea')).toHaveValue('Unsaved change on photo 3');
});

test('pending deletion disables navigation and keeps central edit mode after completion', async ({ page }) => {
  await seed(page);
  await mode(page).click();
  await open(page, 2);
  await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/services/storageService.ts')?.name;
    const { storageService } = await import(moduleUrl || '/services/storageService.ts');
    const deletePhoto = storageService.deletePhoto.bind(storageService);
    storageService.deletePhoto = async id => {
      await new Promise(resolve => { window.releaseNavigationDeletion = resolve; });
      await deletePhoto(id);
    };
  });
  page.once('dialog', dialog => dialog.accept());
  await editor(page).getByRole('button', { name: 'Delete photo', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.releaseNavigationDeletion));
  await expect(previous(page)).toBeDisabled();
  await expect(next(page)).toBeDisabled();
  await expect(editor(page).getByRole('button', { name: 'View mode', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(editor(page).locator('textarea')).toHaveValue('Navigation memory 2');
  await page.evaluate(() => window.releaseNavigationDeletion());
  await expect(editor(page)).toHaveCount(0);
  await expect(mode(page)).toBeChecked();
  await open(page, 3);
  await expect(editor(page)).toBeVisible();
});

for (const editing of [false, true]) {
  test(`${editing ? 'editing' : 'viewing'} reveals only the arrow near the matching viewport edge`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page);
    if (editing) await mode(page).click();
    await open(page, 2);
    await page.mouse.move(720, 450);
    await expectHiddenArrows(page);

    await page.mouse.move(5, 180);
    await expectRevealed(previous(page));
    await expect(next(page)).toHaveCSS('opacity', '0');
    const left = await previous(page).boundingBox();
    expect(left.x).toBeLessThan(80);
    expect(left.y + left.height / 2).toBeCloseTo(450, 0);

    await page.mouse.move(1435, 700);
    await expectRevealed(next(page));
    await expect(previous(page)).toHaveCSS('opacity', '0');
    const right = await next(page).boundingBox();
    expect(right.x + right.width).toBeGreaterThan(1360);
    expect(right.y + right.height / 2).toBeCloseTo(450, 0);

    await navigate(page, 'next');
    await expect(position(page)).toHaveText('3 / 3');
    await page.mouse.move(720, 450);
    await expectHiddenArrows(page);
    await page.keyboard.press('ArrowLeft');
    await expect(position(page)).toHaveText('2 / 3');
    await expectHiddenArrows(page);
    await page.keyboard.press('ArrowLeft');
    await expect(position(page)).toHaveText('1 / 3');

    await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2);
    await expectRevealed(next(page));
    await page.mouse.down();
    await page.mouse.up();
    await expect(position(page)).toHaveText('2 / 3');
    // The next editor/viewer is keyed by photo ID; a stationary pointer must still work.
    await expectRevealed(next(page));
    await page.mouse.down();
    await page.mouse.up();
    await expect(position(page)).toHaveText('3 / 3');
  });
}

test('touch users can discover and tap the edge arrows', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await seed(page);
    await open(page, 2);
    await expect.poll(() => next(page).evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
    await next(page).tap();
    await expect(position(page)).toHaveText('3 / 3');
    await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).tap();
    await expect.poll(() => previous(page).evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
    await previous(page).tap();
    await expect(position(page)).toHaveText('2 / 3');
  } finally {
    await context.close();
  }
});
