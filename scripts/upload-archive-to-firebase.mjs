#!/usr/bin/env node
// One-off: copy a folder archive (ancestry_db.json + ancestry_family_tree.json + images/) into
// the Firebase project used by the hosted app, set the family allowlist, and allow the hosted
// site to fetch images (bucket CORS).
//
// Runs with a service-account key, which bypasses security rules. Keep that key out of the repo.
//
//   node scripts/upload-archive-to-firebase.mjs --key <service-account.json> --allow a@gmail.com,b@gmail.com
//   ...same command plus --apply to actually write.
//
// Options:
//   --archive <dir>   archive root (default ../images, i.e. E:\Photos\images)
//   --key <file>      service-account JSON (or set GOOGLE_APPLICATION_CREDENTIALS)
//   --bucket <name>   Storage bucket (default <projectId>.firebasestorage.app)
//   --allow <emails>  comma-separated Google accounts to add to access/allowlist
//   --origin <url>    extra site origin allowed to fetch images (repeatable)
//   --apply           write; without it this is a dry run
//
// Safe to re-run: files already uploaded are reused, and photo records are overwritten with the
// archive's values (so run it before the family starts editing in the cloud, not after).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const options = name => args.flatMap((value, i) => args[i - 1] === `--${name}` ? [value] : []);
const apply = args.includes('--apply');

const archive = path.resolve(option('archive') || path.join('..', 'images'));
const keyFile = option('key') || process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyFile || !fs.existsSync(keyFile)) {
  console.error('Pass --key <service-account.json> (Firebase console > Project settings > Service accounts > Generate new private key).');
  process.exit(1);
}
const serviceAccount = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
const projectId = serviceAccount.project_id;
const bucketName = option('bucket') || `${projectId}.firebasestorage.app`;
const allow = (option('allow') || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
const origins = ['https://filiphyza.github.io', 'http://127.0.0.1:3000', 'http://localhost:3000', ...options('origin')];

const dbPath = path.join(archive, 'ancestry_db.json');
const treePath = path.join(archive, 'ancestry_family_tree.json');
if (!fs.existsSync(dbPath)) { console.error(`No ancestry_db.json in ${archive}`); process.exit(1); }
const photos = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const tree = fs.existsSync(treePath) ? JSON.parse(fs.readFileSync(treePath, 'utf8')) : null;
if (!Array.isArray(photos)) { console.error('ancestry_db.json is not a photo list.'); process.exit(1); }

const contentTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const kinds = [['originalUrl', 'original'], ['restoredUrl', 'restored'], ['thumbnailUrl', 'thumbnail']];

// Check every referenced file before writing anything.
const missing = [];
let bytes = 0;
for (const photo of photos) for (const [field] of kinds) {
  const url = photo[field];
  if (!url) continue;
  if (!url.startsWith('images/')) { missing.push(`${photo.id} ${field}: not a local archive path`); continue; }
  const file = path.join(archive, url);
  if (!fs.existsSync(file)) missing.push(`${photo.id} ${field}: ${file}`);
  else bytes += fs.statSync(file).size;
}
console.log(`Project ${projectId}, bucket ${bucketName}`);
console.log(`Archive ${archive}: ${photos.length} photos, ${(bytes / 1024 / 1024).toFixed(0)} MB of images, family tree: ${tree ? `${tree.people?.length ?? 0} people` : 'none'}`);
console.log(`Allowlist additions: ${allow.length ? allow.join(', ') : '(none)'}`);
if (missing.length) {
  console.error(`${missing.length} referenced files are missing; nothing was uploaded:\n  ${missing.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
if (!apply) { console.log('Dry run only. Add --apply to upload.'); process.exit(0); }

initializeApp({ credential: cert(serviceAccount), storageBucket: bucketName });
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
const bucket = getStorage().bucket();

const [bucketExists] = await bucket.exists();
if (!bucketExists) {
  console.error(`Bucket ${bucketName} not found. Create Storage in the Firebase console first, or pass --bucket.`);
  process.exit(1);
}

await bucket.setCorsConfiguration([{ origin: origins, method: ['GET', 'HEAD'], responseHeader: ['Content-Type'], maxAgeSeconds: 3600 }]);
console.log(`Bucket CORS allows: ${origins.join(', ')}`);

if (allow.length) {
  await db.doc('access/allowlist').set({ emails: FieldValue.arrayUnion(...allow) }, { merge: true });
  console.log('Allowlist updated.');
}

const downloadUrl = (objectPath, token) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;

const uploadFile = async (localFile, objectPath) => {
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (exists) {
    const [metadata] = await file.getMetadata();
    const token = String(metadata.metadata?.firebaseStorageDownloadTokens || '').split(',')[0];
    if (token && Number(metadata.size) === fs.statSync(localFile).size) return downloadUrl(objectPath, token);
  }
  const token = randomUUID();
  await bucket.upload(localFile, {
    destination: objectPath,
    metadata: {
      contentType: contentTypes[path.extname(localFile).toLowerCase()] || 'application/octet-stream',
      cacheControl: 'private, max-age=31536000',
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return downloadUrl(objectPath, token);
};

let done = 0;
const failures = [];
const queue = [...photos];
const worker = async () => {
  for (let photo = queue.shift(); photo; photo = queue.shift()) {
    try {
      const record = { ...photo, isRestoring: false };
      for (const [field, kind] of kinds) {
        if (photo[field]) record[field] = await uploadFile(path.join(archive, photo[field]), `photos/${photo.id}/${kind}`);
      }
      await db.doc(`photos/${photo.id}`).set(record);
    } catch (error) {
      failures.push(`${photo.id}: ${error.message}`);
    }
    if (++done % 25 === 0 || done === photos.length) console.log(`  ${done}/${photos.length} photos`);
  }
};
await Promise.all(Array.from({ length: 4 }, worker));

if (tree) {
  await db.doc('archive/familyTree').set(tree);
  console.log('Family tree saved.');
}
if (failures.length) {
  console.error(`${failures.length} photos failed (re-run to retry):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('Done.');
