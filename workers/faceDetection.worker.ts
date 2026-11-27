import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import type { DetectedFace } from '../services/faceDetection';

interface Region { x: number; y: number; width: number; height: number; }
const overlap = (a: DetectedFace, b: DetectedFace): number => {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
};

self.onmessage = async (event: MessageEvent<{ image: ImageBitmap; assetBase: string }>) => {
  const { image, assetBase } = event.data;
  let detector: FaceDetector | undefined;
  try {
    const fileset = await FilesetResolver.forVisionTasks(`${assetBase}wasm`, true);
    detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${assetBase}blaze_face_full_range.tflite`, delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
      minSuppressionThreshold: 0.3,
      canvas: new OffscreenCanvas(1, 1),
    });
    self.postMessage({ type: 'progress', phase: 'detecting' });
    const width = image.width, height = image.height;
    const regions: Region[] = [{ x: 0, y: 0, width, height }];
    // Overlapping crops make smaller faces in group photographs easier to locate.
    if (Math.max(width, height) > 640) {
      const cropWidth = Math.ceil(width * 0.65), cropHeight = Math.ceil(height * 0.65);
      for (const y of [0, height - cropHeight]) for (const x of [0, width - cropWidth]) regions.push({ x, y, width: cropWidth, height: cropHeight });
    }
    const candidates: DetectedFace[] = [];
    for (const region of regions) {
      const scale = Math.min(1, 1600 / Math.max(region.width, region.height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(region.width * scale)), Math.max(1, Math.round(region.height * scale)));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not prepare the image for face detection.');
      context.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
      const result = detector.detect(canvas);
      for (const detection of result.detections) {
        const box = detection.boundingBox;
        if (!box) continue;
        const left = Math.max(0, Math.min(width, region.x + box.originX / canvas.width * region.width));
        const top = Math.max(0, Math.min(height, region.y + box.originY / canvas.height * region.height));
        const right = Math.max(left, Math.min(width, region.x + (box.originX + box.width) / canvas.width * region.width));
        const bottom = Math.max(top, Math.min(height, region.y + (box.originY + box.height) / canvas.height * region.height));
        if (right <= left || bottom <= top) continue;
        candidates.push({ id: '', x: left / width * 100, y: top / height * 100, width: (right - left) / width * 100, height: (bottom - top) / height * 100, confidence: detection.categories[0]?.score ?? 0 });
      }
      canvas.width = canvas.height = 1;
    }
    const faces: DetectedFace[] = [];
    for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
      if (!faces.some(face => overlap(face, candidate) > 0.3)) faces.push(candidate);
    }
    faces.sort((a, b) => a.y - b.y || a.x - b.x).forEach((face, index) => { face.id = `face-${index + 1}`; });
    self.postMessage({ type: 'result', faces });
  } catch (error) {
    console.error('Local face detection failed', error);
    self.postMessage({ type: 'error' });
  } finally {
    detector?.close();
    image.close();
  }
};
