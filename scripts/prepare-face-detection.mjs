import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const assetFolder = path.join(root, 'public', 'face-detection');
const modelName = 'blaze_face_full_range.tflite';
const modelUrl = `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/${modelName}`;
const modelHash = '3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b';
await fs.mkdir(path.join(assetFolder, 'wasm'), { recursive: true });
for (const filename of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) {
  await fs.copyFile(path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm', filename), path.join(assetFolder, 'wasm', filename));
}
let bytes;
try { bytes = await fs.readFile(path.join(assetFolder, modelName)); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(modelUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Face detector model download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== modelHash) throw new Error('Face detector model checksum mismatch');
await fs.writeFile(path.join(assetFolder, modelName), bytes);
console.log('Local face-detection assets are ready.');
