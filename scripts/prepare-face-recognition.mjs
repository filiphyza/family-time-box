import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, 'public', 'face-recognition');
const revision = '48b10fa505aeb51fbd127fc60a5c660040e823b7';
const files = [
  { name: 'face_recognition_sface_2021dec.onnx', folder: 'face_recognition_sface', hash: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79' },
  { name: 'face_detection_yunet_2023mar.onnx', folder: 'face_detection_yunet', hash: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' },
  { name: 'face_recognition_sface-LICENSE.txt', folder: 'face_recognition_sface', hash: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', license: true },
  { name: 'face_detection_yunet-LICENSE.txt', folder: 'face_detection_yunet', hash: 'c83b8120c50ccbd4c4f96edf53141bdd566ebb8f8e9227e415326aa1b1aba958', license: true },
];
await fs.mkdir(path.join(assets, 'wasm'), { recursive: true });
for (const file of files) {
  let bytes;
  try { bytes = await fs.readFile(path.join(assets, file.name)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const url = file.license
      ? `https://raw.githubusercontent.com/opencv/opencv_zoo/${revision}/models/${file.folder}/LICENSE`
      : `https://media.githubusercontent.com/media/opencv/opencv_zoo/${revision}/models/${file.folder}/${file.name}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Recognition asset ${file.name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== file.hash) throw new Error(`Recognition asset checksum mismatch: ${file.name}`);
  await fs.writeFile(path.join(assets, file.name), bytes);
}
for (const filename of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await fs.copyFile(path.join(root, 'node_modules', 'onnxruntime-web', 'dist', filename), path.join(assets, 'wasm', filename));
}
console.log('Local SFace recognition models, licenses and runtime are ready.');
