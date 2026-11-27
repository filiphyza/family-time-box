import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import ts from 'typescript';
import UTIF from 'utif2';

const javascript = ts.transpileModule(fs.readFileSync(new URL('../utils/photoCommentDates.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { parsePhotoCommentDate, tiffCommentDate } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

for (const [comment, expected] of [
  ['1990', '1990'], ['1968 Radovánek 1 rok', '1968'], ['1969 Radíček 2 roky', '1969'],
  ['jun 1990', '1990-06'], ['jún 1994 škôlka Senica', '1994-06'], ['jul 1968', '1968-07'], ['júl 1968', '1968-07'],
  ['december 1989', '1989-12'], ['červenec 1968', '1968-07'], ['v říjnu 1984', '1984-10'],
  ['23.10.1970', '1970-10-23'], ['31.8.1969 Radovan gratuluje Bibinke k prvému rôčku (vpravo pradedko)', '1969-08-31'],
  ['29. februára 2000', '2000-02-29'], ['July 23, 1968', '1968-07-23'], ['23rd July 1968', '1968-07-23'],
  ['1984-02-29', '1984-02-29'], ['1984-02', '1984-02'], ['2/1984', '1984-02'], ['02.1984', '1984-02'],
  ['1968, júl 1968', '1968-07'], ['1968-07-23 (23.7.1968)', '1968-07-23'],
]) test(`comment date preserves precision: ${comment}`, () => {
  expect(parsePhotoCommentDate(comment)).toBe(expected);
});

for (const comment of [
  '', 'dedo Palo 10 mesiacov', 'img1968', '1960s', '1968 or 1969', '1968-1970', '1968–69', '1968/69', '1968 - 69', '1968 / 69', 'June or July 1984', '12–13 July 1984', '12 and 13 July 1984',
  '1–2.7.1968', '1. - 2.7.1968', '6.–7.1984', '12.–13. July 1984', '12th–13th July 1984', '30th February 1984', '1968-13', '1968-02-30', '31.2.1968', '29.2.1900', '0/1984', '13/1984',
  '31/8/1969', '05/06/1984', '1984-02-010', '1984/02/01', 'June 1984 or July 1984', '1984-06-01 / 1984-06-02',
]) test(`comment date declines ambiguity or invalidity: ${comment || '(empty)'}`, () => {
  expect(parsePhotoCommentDate(comment)).toBeUndefined();
});

test('Windows XPComment decodes UTF-16LE and takes precedence over scanner description', () => {
  const bytes = new Uint8Array(Buffer.from('jún 1994 škôlka Senica\0', 'utf16le'));
  expect(tiffCommentDate({ t40092: bytes, t270: ['Scanner 2026'], t306: ['2026:11:27 12:00:00'] })).toBe('1994-06');
  expect(tiffCommentDate({ t40092: new Uint8Array(Buffer.from('dedo Palo 10 mesiacov\0', 'utf16le')), t270: ['2026'] })).toBeUndefined();
  expect(tiffCommentDate({ t306: ['2026:11:27 12:00:00'], exifIFD: { t36867: ['2026:11:27 12:00:00'] } })).toBeUndefined();
  expect(tiffCommentDate({ t270: ['Scanner software 2026'] })).toBeUndefined();
  expect(tiffCommentDate({ t270: ['jún 1994'] })).toBe('1994-06');
  expect(tiffCommentDate({ exifIFD: { t37510: new Uint8Array(Buffer.concat([Buffer.from('ASCII\0\0\0'), Buffer.from('jul 1968')])) } })).toBe('1968-07');
});

test('TIFF conversion and upload retain the Windows comment date', async ({ page }) => {
  // utif2 can decode arbitrary byte tags, but its fixture encoder needs the type.
  UTIF._types.basic.rest[40092] = 1;
  const pixels = new Uint8Array(8 * 8 * 4).fill(255);
  const bytes = Buffer.from(UTIF.encodeImage(pixels, 8, 8, {
    t40092: Array.from(Buffer.from('jún 1994 škôlka Senica\0', 'utf16le')),
    t306: ['2026:11:27 12:00:00'],
  }));
  await page.goto('/');
  const date = await page.evaluate(async bytes => {
    const { prepareImageUpload } = await import('/utils/imageUpload.ts');
    return (await prepareImageUpload(new File([new Uint8Array(bytes)], 'comment.tif'))).dateOfPhoto;
  }, Array.from(bytes));
  expect(date).toBe('1994-06');
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'comment.tif', mimeType: 'image/tiff', buffer: bytes });
  await expect(page.locator('img[alt="Family Photo"]')).toBeVisible();
  const photos = await page.evaluate(async () => (await import('/services/storageService.ts')).storageService.loadPhotos());
  expect(photos).toHaveLength(1);
  expect(photos[0].dateOfPhoto).toBe('1994-06');
});



