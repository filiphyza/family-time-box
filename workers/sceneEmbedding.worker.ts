import { FilesetResolver, ImageEmbedder } from '@mediapipe/tasks-vision';
import type { SceneDescriptor } from '../services/sceneEmbedding';

let embedder: Promise<ImageEmbedder> | undefined;
self.onmessage = async (event: MessageEvent<{ image: ImageBitmap; assetBase: string; wasmBase: string }>) => {
  const { image, assetBase, wasmBase } = event.data;
  try {
    embedder ||= (async () => {
      const fileset = await FilesetResolver.forVisionTasks(wasmBase, true);
      return ImageEmbedder.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${assetBase}mobilenet_v3_small.tflite`, delegate: 'CPU' },
        runningMode: 'IMAGE', l2Normalize: true, quantize: false,
        canvas: new OffscreenCanvas(1, 1),
      });
    })();
    const model = await embedder;
    const embedding = model.embed(image).embeddings[0]?.floatEmbedding;
    if (!embedding || embedding.length !== 1024 || !embedding.every(Number.isFinite)) throw new Error('Invalid scene embedding.');
    const canvas = new OffscreenCanvas(16, 16);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare scene comparison.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 16, 16);
    // Scan borders should not dominate the comparison of photographic content.
    const marginX = image.width * 0.04, marginY = image.height * 0.04;
    context.drawImage(image, marginX, marginY, image.width - marginX * 2, image.height - marginY * 2, 0, 0, 16, 16);
    const pixels = context.getImageData(0, 0, 16, 16).data;
    const gray = Array.from({ length: 256 }, (_, index) => {
      const offset = index * 4;
      return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
    });
    const mean = gray.reduce((sum, value) => sum + value, 0) / gray.length;
    const deviation = Math.sqrt(gray.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gray.length);
    let saturation = 0;
    for (let index = 0; index < pixels.length; index += 4) saturation += Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) - Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
    const descriptor: SceneDescriptor = { embedding: [...embedding], gray: gray.map(value => (value - mean) / Math.max(deviation, 8)),
      mean, deviation, saturation: saturation / 256 / 255, aspect: image.width / image.height };
    self.postMessage({ type: 'result', descriptor });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Scene comparison unavailable.' });
  } finally { image.close(); }
};
