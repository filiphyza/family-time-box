// Live smoke test: uses a synthetic color chart, never the user's photos.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createServer, loadEnv } from 'vite';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function colorChart() {
  const width = 192, height = 128;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  const colors = [[210, 60, 60], [70, 160, 90], [60, 100, 210]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = colors[Math.floor(x / 64)];
      const offset = y * (1 + width * 3) + 1 + x * 3;
      pixels.set(color, offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const service = await server.ssrLoadModule('/services/geminiService.ts');
  const image = colorChart();
  console.log('Testing analysis with a synthetic three-color chart...');
  const analysis = await service.analyzePhoto(image);
  assert.ok(analysis.description.length > 0);
  assert.equal(analysis.people_count, 0, 'A color chart should have no people.');
  assert.equal(analysis.location, '', 'A color chart should not imply a location.');
  assert.ok(analysis.tags.length >= 3 && analysis.tags.length <= 5);
  console.log('PASS: actual analysis returned valid JSON, no people, and no invented location.');
  console.log('Testing 2K restoration with the same synthetic chart...');
  const restored = await service.restorePhoto(image);
  assert.match(restored, /^data:image\/(png|jpeg|webp);base64,/);
  const result = Buffer.from(restored.slice(restored.indexOf(',') + 1), 'base64');
  assert.ok(result.length > 1000, 'Expected generated image bytes.');
  console.log(`PASS: actual restoration returned an image (${result.length} bytes).`);
} catch (error) {
  // Avoid printing SDK payloads or request URLs containing credentials.
  if (error.name === 'AssertionError') console.error(`FAIL: ${error.message}`);
  else {
    const env = loadEnv('development', process.cwd(), '');
    let message = String(error.message || 'No details');
    for (const key of [env.GEMINI_API_KEY, env.VITE_GEMINI_API_KEY, env.API_KEY].filter(Boolean)) message = message.replaceAll(key, '[redacted]');
    console.error(`FAIL: live Gemini call failed (status ${error.status ?? 'unknown'}): ${message.slice(0, 650)}`);
  }
  process.exitCode = 1;
} finally {
  await server.close();
}
