import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import ts from 'typescript';

const transpile = path => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const datesUrl = moduleUrl(transpile('../utils/partialDates.ts'));
const { photoDateSortValue, comparePhotoDates } = await import(moduleUrl(transpile('../utils/photoDates.ts').replace("'./partialDates'", JSON.stringify(datesUrl))));

test('photo ordering consistently handles year, month and exact dates', () => {
  const records = ['1984-02-15', '1984', '1983-12-31', '1984-02', '1984-01-02'].map(dateOfPhoto => ({ dateOfPhoto, uploadDate: 1 }));
  expect(records.sort(comparePhotoDates).map(photo => photo.dateOfPhoto))
    .toEqual(['1983-12-31', '1984', '1984-01-02', '1984-02', '1984-02-15']);
  expect(photoDateSortValue({ dateOfPhoto: '1984', uploadDate: 1 })).toBe(Date.UTC(1984, 0, 1));
  expect(photoDateSortValue({ dateOfPhoto: '1984-02', uploadDate: 1 })).toBe(Date.UTC(1984, 1, 1));
});

test('unknown or invalid photo dates follow all dated photos regardless of upload date', () => {
  for (const dateOfPhoto of ['', '--09', 'not a date', '1900-02-29', '2020-04-31', '0000', '10000', '2000-13']) {
    const undated = { dateOfPhoto, uploadDate: 0 };
    const dated = { dateOfPhoto: '9999-12-31', uploadDate: 123456 };
    expect(photoDateSortValue(undated)).toBe(Number.POSITIVE_INFINITY);
    expect([undated, dated].sort(comparePhotoDates)).toEqual([dated, undated]);
  }
  const undated = [{ dateOfPhoto: '', uploadDate: 1 }, { dateOfPhoto: '', uploadDate: 3 }, { dateOfPhoto: '', uploadDate: 2 }];
  expect(undated.sort(comparePhotoDates).map(photo => photo.uploadDate)).toEqual([3, 2, 1]);
  expect(comparePhotoDates(undated[0], undated[0])).toBe(0);
});

test('photo ordering preserves early years and leap dates', () => {
  expect(new Date(photoDateSortValue({ dateOfPhoto: '0001', uploadDate: 1 })).toISOString()).toBe('0001-01-01T00:00:00.000Z');
  expect(photoDateSortValue({ dateOfPhoto: '2000-02-29', uploadDate: 1 })).toBe(Date.UTC(2000, 1, 29));
});
