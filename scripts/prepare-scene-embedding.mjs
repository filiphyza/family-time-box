import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const folder = path.join(root, 'public', 'scene-embedding');
const name = 'mobilenet_v3_small.tflite';
const url = `https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/${name}`;
const sha256 = 'bbbb4c51a55a53905af1daec995ca1aae355046f8839bb8c9f5ce9271394bc40';
await fs.mkdir(folder, { recursive: true });
let bytes;
try { bytes = await fs.readFile(path.join(folder, name)); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Scene embedding model download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Scene embedding model checksum mismatch');
await fs.writeFile(path.join(folder, name), bytes);
await fs.writeFile(path.join(folder, 'NOTICE.txt'), `MobileNetV3 Small image embedding model, official Google MediaPipe release.\nSource: ${url}\nSHA-256: ${sha256}\nDocumentation: https://developers.google.com/edge/mediapipe/solutions/vision/image_embedder\nThe application performs inference locally. No archive image is uploaded.\n`);
console.log('Local scene-embedding assets are ready.');
