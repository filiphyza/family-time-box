import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync(new URL('../utils/partialDates.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { applyPhotoDescriptionDate } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

for (const { title, description, date, language = 'en', expected } of [
  { title: 'an exact English date', description: 'Together at home on 2008-01-01.', date: '2008-01-01', expected: 'Together at home on January 1, 2008.' },
  { title: 'an exact Slovak date', description: 'Spolu doma dňa 2008-01-01.', date: '2008-01-01', language: 'sk', expected: 'Spolu doma dňa 1. januára 2008.' },
  { title: 'a known month without adding a day', description: 'Together at home in 2008-01.', date: '2008-01', expected: 'Together at home in January 2008.' },
  { title: 'a known year without adding a month or day', description: 'Together at home in 2008.', date: '2008', expected: 'Together at home in 2008.' },
  { title: 'an unknown date', description: 'Together at home.', date: undefined, expected: 'Together at home.' },
  { title: 'an invalid calendar date', description: 'Together at home.', date: '2008-02-30', expected: 'Together at home.' },
  { title: 'already natural date wording', description: 'Together at home on January 1, 2008.', date: '2008-01-01', expected: 'Together at home on January 1, 2008.' },
  { title: 'date-like fragments inside other values', description: 'Record x2008-01-01a and 2008-01-010.', date: '2008-01-01', expected: 'Record x2008-01-01a and 2008-01-010.' },
]) test(`caption dates preserve ${title}`, () => {
  expect(applyPhotoDescriptionDate(description, date, language)).toBe(expected);
});
