import { tiffCommentDate } from './photoCommentDates';

export interface PreparedUpload {
  dataUrl: string;
  fileName: string;
  dateOfPhoto?: string;
}

const readDataUrl = (file: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === 'string'
    ? resolve(reader.result)
    : reject(new Error('Could not read the image.'));
  reader.onerror = () => reject(new Error('Could not read the image.'));
  reader.onabort = () => reject(new Error('Image reading was cancelled.'));
  reader.readAsDataURL(file);
});

export const prepareImageUpload = async (file: File, onProgress?: (phase: 'reading' | 'converting') => void): Promise<PreparedUpload> => {
  onProgress?.('reading');
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const tiffHeader = (signature[0] === 0x49 && signature[1] === 0x49 &&
      (signature[2] === 42 || signature[2] === 43) && signature[3] === 0) ||
    (signature[0] === 0x4d && signature[1] === 0x4d && signature[2] === 0 &&
      (signature[3] === 42 || signature[3] === 43));
  const isTiff = tiffHeader || /\.tiff?$/i.test(file.name) || /^(image\/(x-)?tiff|application\/tiff)$/i.test(file.type);
  if (!isTiff) return { dataUrl: await readDataUrl(file), fileName: file.name };

  // Load the decoder only for TIFF uploads; ordinary image uploads stay lightweight.
  if (!tiffHeader || (signature[0] === 0x49 ? signature[2] : signature[3]) !== 42 || file.size < 8) {
    throw new Error('This TIFF format is unsupported or the file is damaged.');
  }
  const UTIF = await import('utif2');
  const buffer = await file.arrayBuffer();
  onProgress?.('converting');
  // Give React and the browser a chance to paint before synchronous TIFF decoding.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const pages = UTIF.decode(buffer);
  const firstPage = pages.find(page => Array.isArray(page.t256) && Array.isArray(page.t257) &&
    Number(page.t256[0]) > 0 && Number(page.t257[0]) > 0);
  if (!firstPage) throw new Error('This TIFF has no readable image page.');
  UTIF.decodeImage(buffer, firstPage);
  const { width, height } = firstPage;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('This TIFF has invalid image dimensions.');
  }
  const rgba = UTIF.toRGBA8(firstPage);
  if (rgba.length !== width * height * 4) throw new Error('Could not decode this TIFF image.');
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('Image conversion is not supported in this browser.');
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

  const orientationTag = Array.isArray(firstPage.t274) ? Number(firstPage.t274[0]) : 1;
  const orientation = orientationTag >= 1 && orientationTag <= 8 ? orientationTag : 1;
  const canvas = document.createElement('canvas');
  canvas.width = orientation >= 5 ? height : width;
  canvas.height = orientation >= 5 ? width : height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image conversion is not supported in this browser.');
  // JPEG has no alpha channel: transparent scan margins should be white.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const transforms: Record<number, [number, number, number, number, number, number]> = {
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, width, 0],
    3: [-1, 0, 0, -1, width, height],
    4: [1, 0, 0, -1, 0, height],
    5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, height, 0],
    7: [0, -1, -1, 0, height, width],
    8: [0, -1, 1, 0, 0, width],
  };
  context.setTransform(...transforms[orientation]);
  context.drawImage(source, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
  // Release large scan buffers between sequential uploads.
  source.width = source.height = canvas.width = canvas.height = 0;
  if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Could not convert the TIFF to JPEG.');
  const stem = /\.tiff?$/i.test(file.name) ? file.name.replace(/\.tiff?$/i, '') : file.name.replace(/\.[^.]+$/, '');
  return { dataUrl, fileName: `${stem || 'scan'}.jpg`, dateOfPhoto: tiffCommentDate(firstPage) };
};


