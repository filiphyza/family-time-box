import assert from 'node:assert/strict';
import { createServer } from 'vite';
const originalFetch = globalThis.fetch;
let handleRequest;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (request.url.startsWith('blob:')) return originalFetch(request);
  assert.ok(request.url.startsWith('https://generativelanguage.googleapis.com/'));
  return handleRequest(request.url, await request.json());
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const caption = { description: 'Three colored blocks.', location: '', tags: ['red', 'green', 'blue'], people_count: 0 };
const response = { candidates: [{ content: { parts: [{ text: JSON.stringify(caption) }] } }] };
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const service = await server.ssrLoadModule('/services/geminiService.ts');
  const input = 'data:image/png;base64,aGVsbG8=';
  handleRequest = (url, body) => {
    assert.ok(url.includes('gemini-nano-banana-2.1'));
    assert.equal(body.generationConfig.imageConfig.imageSize, '2K');
    assert.equal(body.generationConfig.imageConfig.aspectRatio, undefined);
    return reply({ candidates: [{ content: { parts: [
      { thought: true, inlineData: { mimeType: 'image/png', data: 'dGhvdWdodA==' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'cmVzdWx0' } },
    ] } }] });
  };
  assert.equal(await service.restorePhoto(input), 'data:image/jpeg;base64,cmVzdWx0');
  console.log('PASS: 2K restoration keeps framing unconstrained and uses the final image MIME type.');
  const blobUrl = URL.createObjectURL(new Blob(['hello'], { type: 'image/png' }));
  let calls = 0;
  handleRequest = (url, body) => {
    calls++;
    assert.equal(body.contents[0].parts[0].inlineData.data, 'aGVsbG8=');
    assert.equal(body.generationConfig.temperature, undefined);
    if (calls === 1) return reply({ error: { code: 503, message: 'Temporarily unavailable', status: 'UNAVAILABLE' } }, 503);
    assert.ok(url.includes('gemini-3.1-flash-lite'));
    return reply(response);
  };
  try { assert.deepEqual(await service.analyzePhoto(blobUrl), caption); }
  finally { URL.revokeObjectURL(blobUrl); }
  assert.equal(calls, 2);
  console.log('PASS: blob images are encoded, and availability failures use the stable caption fallback.');
  calls = 0;
  handleRequest = () => { calls++; return reply({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, 429); };
  await assert.rejects(service.analyzePhoto(input), error => error.status === 429);
  assert.equal(calls, 1);
  assert.match(service.getGeminiErrorMessage({ status: 429 }, 'en'), /quota/);
  console.log('PASS: quota errors are not retried and display a billing/limits explanation.');
  handleRequest = () => reply({ candidates: [{ content: { parts: [{ text: '{"description":"Incomplete"}' }] } }] });
  await assert.rejects(service.analyzePhoto(input), /incomplete analysis/);
  console.log('PASS: incomplete model output cannot overwrite photo metadata.');
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
