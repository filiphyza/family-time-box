// Rebuild only missing original JPEGs when exactly one matching TIFF exists.
// Original TIFFs, existing JPEGs and archive metadata are never modified.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(process.argv[2] || '..');
const records = JSON.parse(await fs.readFile(path.join(root, 'ancestry_db.json'), 'utf8'));
const sources = new Map();
async function scan(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (['ancestrylens-app', 'images', 'node_modules', '.git'].includes(entry.name)) continue;
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) await scan(fullPath);
    else if (entry.isFile() && /\.tiff?$/i.test(entry.name)) {
      const stem = path.parse(entry.name).name.toLowerCase();
      sources.set(stem, [...(sources.get(stem) || []), fullPath]);
    }
  }
}
await scan(root);
const planned = [];
for (const record of records) {
  if (!/^images\/[a-zA-Z0-9_-]+_original\.jpe?g$/.test(record.originalUrl || '')) continue;
  const target = path.resolve(root, record.originalUrl);
  if (!target.startsWith(path.join(root, 'images') + path.sep)) throw new Error('Unsafe output path');
  try { await fs.access(target); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const matches = sources.get(path.parse(record.fileName).name.toLowerCase()) || [];
  if (matches.length !== 1) { console.log(`Skipped ${record.id}: expected one matching TIFF, found ${matches.length}.`); continue; }
  planned.push({ source: matches[0], target });
}
console.log(`Found ${planned.length} recoverable missing JPEGs.`);
if (!planned.length) process.exit(0);
await fs.mkdir(path.join(root, 'images'), { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
let recovered = 0;
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'repair-source'; document.body.append(input); });
  for (const item of planned) {
    await page.locator('#repair-source').setInputFiles(item.source);
    const dataUrl = await page.evaluate(async () => {
      const { prepareImageUpload } = await import('/utils/imageUpload.ts');
      const prepared = await prepareImageUpload(document.querySelector('#repair-source').files[0]);
      return prepared.dataUrl;
    });
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Conversion did not return JPEG');
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Invalid JPEG data');
    await fs.writeFile(item.target, bytes, { flag: 'wx' });
    recovered++;
    if (recovered % 10 === 0 || recovered === planned.length) console.log(`Recovered ${recovered}/${planned.length} JPEGs.`);
  }
} finally { await browser.close(); }
console.log('Recovery complete. Source TIFFs and archive metadata are unchanged.');
