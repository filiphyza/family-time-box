// Import explicit Windows Comments dates into the connected local archive.
// Run: node scripts/import-tiff-comment-dates.mjs E:\Photos [--apply]
// Source TIFFs are read only. The initial archive/source image correspondence was
// independently checked using exact dimensions and near-identical RGB previews.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import UTIF from 'utif2';

const root = path.resolve(process.argv[2] || '..');
const apply = process.argv.includes('--apply');
const familyFolders = ['dedo Palo detstvo', 'Filip detstvo', 'naši', 'tatino detstvo'];
const databasePaths = [path.join(root, 'images', 'ancestry_db.json')];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(root, `tiff-comment-date-import-${stamp}.json`);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parserText = await fs.readFile(new URL('../utils/photoCommentDates.ts', import.meta.url), 'utf8');
const parserJs = ts.transpileModule(parserText, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parsePhotoCommentDate, tiffCommentDate } = await import(`data:text/javascript;base64,${Buffer.from(parserJs).toString('base64')}`);

const readExact = async (handle, length, position) => {
  const result = Buffer.alloc(length);
  const { bytesRead } = await handle.read(result, 0, length, position);
  if (bytesRead !== length) throw new Error('Truncated TIFF metadata');
  return result;
};

// Read just the classic TIFF directory and XPComment (40092). Large scan pixel
// strips never enter memory. A compact TIFF lets the installed UTIF decoder
// retain ownership of tag decoding without allocating the original scan size.
const readWindowsComment = async filename => {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    const header = await readExact(handle, 8, 0);
    const little = header.toString('ascii', 0, 2) === 'II';
    if (!little && header.toString('ascii', 0, 2) !== 'MM') throw new Error('Invalid TIFF byte order');
    const u16 = (buffer, offset) => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    const u32 = (buffer, offset) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (u16(header, 2) !== 42) throw new Error('Unsupported TIFF format (classic TIFF expected)');
    const offset = u32(header, 4);
    if (offset < 8 || offset + 2 > stat.size) throw new Error('Invalid TIFF directory offset');
    const count = u16(await readExact(handle, 2, offset), 0);
    if (count > 4096 || offset + 2 + count * 12 + 4 > stat.size) throw new Error('Invalid TIFF directory size');
    const entries = await readExact(handle, count * 12, offset + 2);
    for (let index = 0; index < count; index++) {
      const start = index * 12;
      if (u16(entries, start) !== 40092) continue;
      const type = u16(entries, start + 2), length = u32(entries, start + 4);
      if (type !== 1 && type !== 7) throw new Error('Unsupported XPComment encoding');
      if (!length) return '';
      if (length > 131074) throw new Error('XPComment is too long');
      const position = u32(entries, start + 8);
      if (length > 4 && (position < 8 || position + length > stat.size)) throw new Error('Invalid XPComment offset');
      const bytes = length <= 4 ? entries.subarray(start + 8, start + 8 + length) : await readExact(handle, length, position);
      const compact = Buffer.alloc(26 + bytes.length);
      compact.write('II', 0, 'ascii'); compact.writeUInt16LE(42, 2); compact.writeUInt32LE(8, 4);
      compact.writeUInt16LE(1, 8); compact.writeUInt16LE(40092, 10); compact.writeUInt16LE(type, 12); compact.writeUInt32LE(length, 14);
      if (length <= 4) bytes.copy(compact, 18); else { compact.writeUInt32LE(26, 18); bytes.copy(compact, 26); }
      const page = UTIF.decode(compact.buffer.slice(compact.byteOffset, compact.byteOffset + compact.byteLength))[0];
      const decoded = Buffer.from(page.t40092).toString('utf16le').replace(/\0+$/g, '').trim();
      const date = tiffCommentDate(page);
      if (date !== parsePhotoCommentDate(decoded)) throw new Error('Comment decoding disagreement');
      return decoded;
    }
    return '';
  } finally { await handle.close(); }
};

const sourceFiles = [];
const listSources = async (directory, recursive) => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /\.tiff?$/i.test(entry.name)) sourceFiles.push(path.join(directory, entry.name));
    else if (recursive && entry.isDirectory()) await listSources(path.join(directory, entry.name), true);
  }
};
await listSources(root, false);
for (const folder of familyFolders) await listSources(path.join(root, folder), true);
sourceFiles.sort();
const byStem = new Map(), sources = [], failures = [];
for (const filename of sourceFiles) {
  const stem = path.parse(filename).name.toLowerCase();
  const existing = byStem.get(stem) || [];
  const source = { file: filename, comment: '', date: null };
  existing.push(source); byStem.set(stem, existing);
  try { source.comment = await readWindowsComment(filename); source.date = parsePhotoCommentDate(source.comment) || null; }
  catch (error) { failures.push({ file: filename, error: error.message }); }
  if (source.comment) sources.push(source);
}

const plans = [];
for (const filename of databasePaths) {
  const initial = await fs.readFile(filename);
  const records = JSON.parse(initial.toString('utf8'));
  if (!Array.isArray(records)) throw new Error(`Invalid archive: ${filename}`);
  const updated = structuredClone(records), changes = [], skipped = [];
  for (let index = 0; index < updated.length; index++) {
    const photo = updated[index];
    if (!photo || typeof photo !== 'object' || typeof photo.fileName !== 'string') throw new Error(`Invalid archive record ${index}: ${filename}`);
    const matches = byStem.get(path.parse(photo.fileName).name.toLowerCase());
    if (!matches?.some(source => source.date)) continue;
    if (matches.length !== 1) { skipped.push({ index, id: photo.id, fileName: photo.fileName, reason: 'ambiguous-source-filename' }); continue; }
    const source = matches[0], before = photo.dateOfPhoto;
    if (before && before !== source.date) { skipped.push({ index, id: photo.id, fileName: photo.fileName, source: source.file, comment: source.comment, before, proposed: source.date, reason: 'existing-date-conflict' }); continue; }
    if (before === source.date) { skipped.push({ index, id: photo.id, fileName: photo.fileName, source: source.file, date: before, reason: 'already-dated' }); continue; }
    changes.push({ index, id: photo.id, fileName: photo.fileName, source: source.file, comment: source.comment, before: before ?? null, beforeFieldPresent: Object.hasOwn(photo, 'dateOfPhoto'), after: source.date });
    photo.dateOfPhoto = source.date;
  }
  const withoutDates = items => items.map(item => { const result = { ...item }; delete result.dateOfPhoto; return result; });
  if (!isDeepStrictEqual(withoutDates(records), withoutDates(updated))) throw new Error(`Unexpected change outside dateOfPhoto: ${filename}`);
  for (let index = 0; index < records.length; index++) {
    if (!changes.some(change => change.index === index) && !isDeepStrictEqual(records[index], updated[index])) throw new Error(`Unexpected untouched record change: ${filename}`);
  }
  const output = Buffer.from(JSON.stringify(updated, null, 2) + '\n');
  if (!isDeepStrictEqual(JSON.parse(output.toString('utf8')), updated)) throw new Error('Archive round-trip validation failed');
  plans.push({ filename, initial, records, updated, output, changes, skipped });
}
const matchedSources = new Set(plans.flatMap(plan => plan.changes.map(change => change.source)));
const report = {
  createdAt: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', root,
  matchBasis: 'Unique source filename stems; TIFF and archived JPEG dimensions and RGB previews independently verified before application.',
  scannedTiffs: sourceFiles.length, commentedTiffs: sources.length, datedTiffs: sources.filter(source => source.date).length,
  sources, failures, unmatchedDatedSources: sources.filter(source => source.date && !plans.some(plan => plan.records.some(photo => path.parse(photo.fileName).name.toLowerCase() === path.parse(source.file).name.toLowerCase()))),
  changedRecords: plans.reduce((sum, plan) => sum + plan.changes.length, 0), distinctChangedSources: matchedSources.size,
  archives: plans.map(plan => ({ file: plan.filename, recordCount: plan.records.length, initialSha256: hash(plan.initial), changes: plan.changes, skipped: plan.skipped, status: 'planned', backup: null })),
};
const saveReport = async () => {
  const temp = `${reportPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(temp, reportPath);
};
if (apply) {
  if (failures.length) throw new Error(`Refusing migration after ${failures.length} TIFF metadata read failure(s): ${JSON.stringify(failures)}`);
  // Check every archive before creating any backup or changing any database.
  for (const plan of plans) if (!(await fs.readFile(plan.filename)).equals(plan.initial)) throw new Error(`Archive changed during scan: ${plan.filename}`);
  await saveReport();
  for (const [index, plan] of plans.entries()) {
    const record = report.archives[index];
    if (!plan.changes.length) { record.status = 'unchanged'; await saveReport(); continue; }
    const backup = `${plan.filename}.before-comment-dates-${stamp}.bak`;
    const temporary = `${plan.filename}.comment-dates-${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(backup, plan.initial, { flag: 'wx' });
      if (!(await fs.readFile(backup)).equals(plan.initial)) throw new Error(`Backup validation failed: ${backup}`);
      record.backup = backup; record.status = 'backed-up'; await saveReport();
      await fs.writeFile(temporary, plan.output, { flag: 'wx' });
      if (!(await fs.readFile(plan.filename)).equals(plan.initial)) throw new Error(`Archive changed before commit: ${plan.filename}`);
      await fs.rename(temporary, plan.filename);
      const saved = await fs.readFile(plan.filename);
      if (!saved.equals(plan.output) || !isDeepStrictEqual(JSON.parse(saved.toString('utf8')), plan.updated)) throw new Error(`Saved archive validation failed: ${plan.filename}`);
      record.status = 'committed'; record.finalSha256 = hash(saved); record.finalRecordCount = plan.updated.length;
      await saveReport();
    } catch (error) {
      record.status = 'failed'; record.error = error.message;
      await saveReport();
      throw error;
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
console.log(JSON.stringify({ mode: report.mode, scannedTiffs: report.scannedTiffs, commentedTiffs: report.commentedTiffs, datedTiffs: report.datedTiffs, changedRecords: report.changedRecords, distinctChangedSources: report.distinctChangedSources, unmatchedDatedSources: report.unmatchedDatedSources.length, failures: failures.length, archives: report.archives.map(({ file, recordCount, changes, skipped, status, backup }) => ({ file, recordCount, changedRecords: changes.length, skipped: skipped.length, status, backup })), ...(apply ? { reportPath } : {}) }, null, 2));
