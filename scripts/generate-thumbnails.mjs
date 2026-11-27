// Backfill a local archive using the same thumbnail encoder as the app.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from '@playwright/test';

const root = path.resolve(process.argv[2] || '..');
const databasePath = path.join(root, 'ancestry_db.json');
const initialBytes = await fs.readFile(databasePath);
const records = JSON.parse(initialBytes.toString('utf8'));
if (!Array.isArray(records)) throw new Error('Invalid photo archive');
const containedPath = relative => {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.join(root, 'images') + path.sep)) throw new Error('Image path is outside the archive');
  return resolved;
};
const kind = photo => photo.restoredUrl ? 'restored' : 'original';
const source = photo => photo.restoredUrl || photo.originalUrl;
const pending = [];
for (const photo of records) {
  if (!/^[a-zA-Z0-9_-]+$/.test(photo.id)) throw new Error('Unsafe photo identifier');
  if (photo.thumbnailUrl && photo.thumbnailSource === kind(photo)) {
    try { await fs.access(containedPath(photo.thumbnailUrl)); continue; } catch {}
  }
  pending.push(photo);
}
console.log(JSON.stringify({ photos: records.length, pending: pending.length }));
if (!pending.length) process.exit(0);
const backupPath = `${databasePath}.before-thumbnails-${Date.now()}.bak`;
await fs.writeFile(backupPath, initialBytes, { flag: 'wx' });
const utility = await fs.readFile(fileURLToPath(new URL('../utils/thumbnails.ts', import.meta.url)), 'utf8');
const javascript = ts.transpileModule(utility, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
let generated = 0, failures = 0, originalBytes = 0, thumbnailBytes = 0;
try {
  const page = await browser.newPage();
  await page.evaluate(async javascript => {
    const url = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }));
    window.archiveThumbnail = (await import(url)).createThumbnail;
    URL.revokeObjectURL(url);
  }, javascript);
  for (const photo of pending) {
    try {
      const input = source(photo);
      let dataUrl = input;
      let originalPath, originalHash;
      if (!input.startsWith('data:')) {
        originalPath = containedPath(input);
        const bytes = await fs.readFile(originalPath);
        originalHash = crypto.createHash('sha256').update(bytes).digest('hex');
        originalBytes += bytes.length;
        const mime = /\.png$/i.test(input) ? 'image/png' : /\.webp$/i.test(input) ? 'image/webp' : /\.gif$/i.test(input) ? 'image/gif' : 'image/jpeg';
        dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
      }
      const thumbnail = await page.evaluate(dataUrl => window.archiveThumbnail(dataUrl), dataUrl);
      if (!thumbnail.startsWith('data:image/webp;base64,')) throw new Error('Expected WebP preview');
      const bytes = Buffer.from(thumbnail.split(',')[1], 'base64');
      const latest = JSON.parse(await fs.readFile(databasePath, 'utf8'));
      const current = latest.find(item => item.id === photo.id);
      if (!current || source(current) !== input) continue;
      const relative = `images/${photo.id}_thumbnail.webp`;
      await fs.writeFile(containedPath(relative), bytes);
      current.thumbnailUrl = relative;
      current.thumbnailSource = kind(photo);
      // Refuse to overwrite any concurrent archive edit made during thumbnail output.
      const beforeCommit = await fs.readFile(databasePath, 'utf8');
      const checked = JSON.parse(beforeCommit);
      const checkedPhoto = checked.find(item => item.id === photo.id);
      if (!checkedPhoto || source(checkedPhoto) !== input) continue;
      checkedPhoto.thumbnailUrl = relative;
      checkedPhoto.thumbnailSource = kind(photo);
      const temporaryPath = `${databasePath}.thumbnail-tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(checked, null, 2));
      if (await fs.readFile(databasePath, 'utf8') !== beforeCommit) throw new Error('Archive changed during thumbnail migration; rerun to continue');
      await fs.rename(temporaryPath, databasePath);
      if (originalPath && crypto.createHash('sha256').update(await fs.readFile(originalPath)).digest('hex') !== originalHash) throw new Error('Original image changed during migration');
      generated++; thumbnailBytes += bytes.length;
      if (generated % 10 === 0) console.log(JSON.stringify({ generated, total: pending.length }));
    } catch (error) { failures++; console.error(`Thumbnail failed for ${photo.id}: ${error.message}`); }
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ generated, failures, originalBytes, thumbnailBytes, backupPath }));
if (failures) process.exitCode = 1;
