import * as ort from 'onnxruntime-web/wasm';
import type { RecognitionFace } from '../services/faceRecognition';

type Point = { x: number; y: number };
type Candidate = Omit<RecognitionFace, 'id' | 'embedding'> & { landmarks: Point[] };
const SIZE = 640;
// SFace's OpenCV alignment target, in pixel coordinates of the 112 x 112 crop.
const TARGET: Point[] = [
  { x: 38.2946, y: 51.6963 }, { x: 73.5318, y: 51.5014 }, { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 }, { x: 70.7299, y: 92.2041 },
];
let sessions: Promise<[ort.InferenceSession, ort.InferenceSession]> | undefined;

function loadSessions(assetBase: string) {
  if (!sessions) {
    // Single-thread WASM works without SharedArrayBuffer/COOP/COEP and on CPU-only devices.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = `${assetBase}wasm/`;
    const options: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    sessions = Promise.all([
      ort.InferenceSession.create(`${assetBase}face_detection_yunet_2023mar.onnx`, options),
      ort.InferenceSession.create(`${assetBase}face_recognition_sface_2021dec.onnx`, options),
    ]);
  }
  return sessions;
}

function overlap(a: Candidate, b: Candidate) {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
}

function tensorFromPixels(pixels: Uint8ClampedArray, size: number, rgb: boolean) {
  const count = size * size;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; ++i) {
    // YuNet takes BGR; SFace takes RGB, both raw 0..255 (model handles normalization).
    data[i] = pixels[i * 4 + (rgb ? 0 : 2)];
    data[count + i] = pixels[i * 4 + 1];
    data[count * 2 + i] = pixels[i * 4 + (rgb ? 2 : 0)];
  }
  return new ort.Tensor('float32', data, [1, 3, size, size]);
}

async function detect(image: ImageBitmap, detector: ort.InferenceSession): Promise<Candidate[]> {
  const regions = [{ x: 0, y: 0, width: image.width, height: image.height }];
  if (Math.max(image.width, image.height) > SIZE) {
    const width = Math.ceil(image.width * 0.65), height = Math.ceil(image.height * 0.65);
    for (const y of [0, image.height - height]) for (const x of [0, image.width - width]) regions.push({ x, y, width, height });
  }
  const candidates: Candidate[] = [];
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not prepare face detection.');
  for (const region of regions) {
    const scale = Math.min(SIZE / region.width, SIZE / region.height);
    context.fillStyle = '#000'; context.fillRect(0, 0, SIZE, SIZE);
    context.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, region.width * scale, region.height * scale);
    const input = tensorFromPixels(context.getImageData(0, 0, SIZE, SIZE).data, SIZE, false);
    const output = await detector.run({ [detector.inputNames[0]]: input });
    try {
      for (const stride of [8, 16, 32]) {
        const cls = output[`cls_${stride}`].data as Float32Array;
        const obj = output[`obj_${stride}`].data as Float32Array;
        const box = output[`bbox_${stride}`].data as Float32Array;
        const points = output[`kps_${stride}`].data as Float32Array;
        const columns = SIZE / stride;
        for (let i = 0; i < cls.length; ++i) {
          const confidence = Math.sqrt(Math.max(0, Math.min(1, cls[i])) * Math.max(0, Math.min(1, obj[i])));
          if (confidence < 0.75) continue;
          const col = i % columns, row = Math.floor(i / columns);
          const cx = (col + box[i * 4]) * stride / scale + region.x;
          const cy = (row + box[i * 4 + 1]) * stride / scale + region.y;
          const width = Math.exp(box[i * 4 + 2]) * stride / scale;
          const height = Math.exp(box[i * 4 + 3]) * stride / scale;
          // Small source faces do not provide trustworthy recognition samples.
          if (!Number.isFinite(width + height) || width < 20 || height < 20) continue;
          if (cx < region.x || cy < region.y || cx > region.x + region.width || cy > region.y + region.height) continue;
          const x = Math.max(0, cx - width / 2), y = Math.max(0, cy - height / 2);
          const right = Math.min(image.width, cx + width / 2), bottom = Math.min(image.height, cy + height / 2);
          const landmarks: Point[] = [];
          for (let j = 0; j < 5; ++j) landmarks.push({
            x: (points[i * 10 + j * 2] + col) * stride / scale + region.x,
            y: (points[i * 10 + j * 2 + 1] + row) * stride / scale + region.y,
          });
          if (right > x && bottom > y && landmarks.every(p => Number.isFinite(p.x + p.y))) candidates.push({ x, y, width: right - x, height: bottom - y, landmarks, confidence });
        }
      }
    } finally { input.dispose(); Object.values(output).forEach(value => value.dispose()); }
  }
  const faces: Candidate[] = [];
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    if (!faces.some(face => overlap(face, candidate) > 0.3)) faces.push(candidate);
  }
  return faces.sort((a, b) => a.y - b.y || a.x - b.x);
}

function alignedInput(image: ImageBitmap, points: Point[]) {
  // Least-squares, orientation-preserving similarity transform: u=a*x-b*y+tx, v=b*x+a*y+ty.
  const src = points.reduce((s, p) => ({ x: s.x + p.x / 5, y: s.y + p.y / 5 }), { x: 0, y: 0 });
  const dst = TARGET.reduce((s, p) => ({ x: s.x + p.x / 5, y: s.y + p.y / 5 }), { x: 0, y: 0 });
  let numeratorA = 0, numeratorB = 0, denominator = 0;
  points.forEach((point, i) => {
    const x = point.x - src.x, y = point.y - src.y;
    const u = TARGET[i].x - dst.x, v = TARGET[i].y - dst.y;
    numeratorA += x * u + y * v; numeratorB += x * v - y * u; denominator += x * x + y * y;
  });
  if (!Number.isFinite(denominator) || denominator < 1) return null;
  const a = numeratorA / denominator, b = numeratorB / denominator;
  const tx = dst.x - a * src.x + b * src.y, ty = dst.y - b * src.x - a * src.y;
  const canvas = new OffscreenCanvas(112, 112);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not align face.');
  context.fillStyle = '#000'; context.fillRect(0, 0, 112, 112);
  context.setTransform(a, b, -b, a, tx, ty);
  context.drawImage(image, 0, 0);
  context.resetTransform();
  return tensorFromPixels(context.getImageData(0, 0, 112, 112).data, 112, true);
}

self.onmessage = async (event: MessageEvent<{ image: ImageBitmap; assetBase: string }>) => {
  const { image, assetBase } = event.data;
  try {
    self.postMessage({ type: 'progress', phase: 'loading' });
    const [detector, recognizer] = await loadSessions(assetBase);
    self.postMessage({ type: 'progress', phase: 'recognizing' });
    const candidates = await detect(image, detector);
    const faces: RecognitionFace[] = [];
    for (const candidate of candidates) {
      const input = alignedInput(image, candidate.landmarks);
      if (!input) continue;
      const output = await recognizer.run({ [recognizer.inputNames[0]]: input });
      try {
        const values = Array.from(output[recognizer.outputNames[0]].data as Float32Array);
        const norm = Math.hypot(...values);
        if (values.length !== 128 || !Number.isFinite(norm) || norm < 1e-8) throw new Error('Invalid SFace embedding.');
        faces.push({ id: `recognized-${faces.length + 1}`, x: candidate.x / image.width * 100, y: candidate.y / image.height * 100,
          width: candidate.width / image.width * 100, height: candidate.height / image.height * 100,
          confidence: candidate.confidence, embedding: values.map(value => value / norm) });
      } finally { input.dispose(); Object.values(output).forEach(value => value.dispose()); }
    }
    self.postMessage({ type: 'result', faces });
  } catch (error) {
    console.error('Local face recognition failed', error);
    self.postMessage({ type: 'error', message: 'Local face recognition is unavailable. Please try again.' });
  } finally { image.close(); }
};
