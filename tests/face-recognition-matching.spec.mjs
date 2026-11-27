import { test, expect } from '@playwright/test';

async function matching(page, scenario) {
  await page.goto('/');
  return page.evaluate(async scenario => {
    const { validFaceIndex, buildFaceReferences, suggestFace } = await import('/utils/faceMatching.ts');
    const vector = (first = 1, second = 0) => [first, second, ...Array(126).fill(0)];
    const face = { id: 'face-1', x: 10, y: 10, width: 20, height: 30, confidence: 0.98, embedding: vector() };
    const tag = { id: 'tag-1', name: 'Anna', x: 20, y: 25 };
    const index = { modelId: 'sface-test', faces: [face] };
    const photo = { id: 'reference-photo', people: ['Unrelated Person'], faceTags: [tag], faceRecognition: index };
    const ref = { name: 'Anna', photoId: photo.id, faceId: face.id, embedding: vector() };
    if (scenario === 'validate') {
      return [
        validFaceIndex(index, 'sface-test'),
        validFaceIndex({ modelId: 'sface-test', faces: [] }, 'sface-test'),
        validFaceIndex(index, 'old-model'),
        validFaceIndex({ ...index, faces: [{ ...face, embedding: Array(128).fill(0) }] }, 'sface-test'),
        validFaceIndex({ ...index, faces: [{ ...face, embedding: [NaN, ...Array(127).fill(0)] }] }, 'sface-test'),
        validFaceIndex({ ...index, faces: [{ ...face, embedding: Array(127).fill(1) }] }, 'sface-test'),
        validFaceIndex({ ...index, faces: [{ ...face, x: 95 }] }, 'sface-test'),
        validFaceIndex({ ...index, faces: [{ ...face, width: -1 }] }, 'sface-test'),
        validFaceIndex({ ...index, faces: [face, face] }, 'sface-test'),
      ];
    }
    if (scenario === 'reference') {
      return {
        confirmed: buildFaceReferences([photo], [], 'sface-test'),
        justNames: buildFaceReferences([{ ...photo, faceTags: [] }], [], 'sface-test'),
        oldModel: buildFaceReferences([photo], [], 'old-model'),
        self: buildFaceReferences([photo], [], 'sface-test', photo.id),
        outside: buildFaceReferences([{ ...photo, faceTags: [{ ...tag, x: 75 }] }], [], 'sface-test'),
      };
    }
    if (scenario === 'ambiguous') {
      return {
        duplicateTags: buildFaceReferences([{ ...photo, faceTags: [tag, { ...tag, id: 'tag-2', name: 'Peter' }] }], [], 'sface-test'),
        overlappingFaces: buildFaceReferences([{ ...photo, faceRecognition: { ...index, faces: [face, { ...face, id: 'face-2', x: 15 }] } }], [], 'sface-test'),
        duplicateNames: buildFaceReferences([photo], [{ id: 'anna-1', name: 'Anna' }, { id: 'anna-2', name: 'Anna' }], 'sface-test'),
      };
    }
    if (scenario === 'rename') {
      const tree = [{ id: 'stable-anna', name: 'Anna New' }];
      return {
        stable: buildFaceReferences([{ ...photo, faceTags: [{ ...tag, personId: 'stable-anna' }] }], tree, 'sface-test'),
        legacy: buildFaceReferences([photo], [{ id: 'stable-anna', name: 'Anna' }], 'sface-test'),
      };
    }
    if (scenario === 'suggest') {
      return {
        exact: suggestFace(face, [ref]),
        weak: suggestFace(face, [{ ...ref, embedding: vector(0, 1) }]),
        invalid: suggestFace({ embedding: Array(128).fill(0) }, [ref]),
        empty: suggestFace(face, []),
        closeRunner: suggestFace(face, [ref, { ...ref, name: 'Peter', embedding: vector(0.98, Math.sqrt(1 - 0.98 ** 2)) }]),
        samePerson: suggestFace(face, [{ ...ref, personId: 'anna' }, { ...ref, name: 'Anna Older Name', personId: 'anna', embedding: vector(0.98, Math.sqrt(1 - 0.98 ** 2)) }]),
        distinct: suggestFace(face, [ref, { ...ref, name: 'Peter', embedding: vector(0.6, 0.8) }]),
      };
    }
    if (scenario === 'threshold') {
      return {
        above: suggestFace(face, [{ ...ref, embedding: vector(0.56, Math.sqrt(1 - 0.56 ** 2)) }]),
        below: suggestFace(face, [{ ...ref, embedding: vector(0.54, Math.sqrt(1 - 0.54 ** 2)) }]),
        configured: suggestFace(face, [{ ...ref, embedding: vector(0.56, Math.sqrt(1 - 0.56 ** 2)) }], { threshold: 0.7 }),
        normalized: suggestFace({ embedding: vector(1.01) }, [{ ...ref, embedding: vector(0.99) }]),
      };
    }
  }, scenario);
}

test('recognition indices reject stale models, malformed boxes and invalid descriptors', async ({ page }) => {
  expect(await matching(page, 'validate')).toEqual([true, true, false, false, false, false, false, false, false]);
});

test('only spatially confirmed tags enroll reference faces, excluding the current image', async ({ page }) => {
  const result = await matching(page, 'reference');
  expect(result.confirmed).toHaveLength(1);
  expect(result.confirmed[0]).toMatchObject({ name: 'Anna', photoId: 'reference-photo', faceId: 'face-1' });
  for (const key of ['justNames', 'oldModel', 'self', 'outside']) expect(result[key]).toEqual([]);
});

test('ambiguous tags, overlapping faces and duplicate legacy identities cannot enroll', async ({ page }) => {
  expect(await matching(page, 'ambiguous')).toEqual({ duplicateTags: [], overlappingFaces: [], duplicateNames: [] });
});

test('references use current tree names and resolve legacy name tags to stable person IDs', async ({ page }) => {
  const result = await matching(page, 'rename');
  expect(result.stable[0]).toMatchObject({ name: 'Anna New', personId: 'stable-anna' });
  expect(result.legacy[0]).toMatchObject({ name: 'Anna', personId: 'stable-anna' });
});

test('suggestions reject weak and ambiguous identities while grouping multiple samples of one person', async ({ page }) => {
  const result = await matching(page, 'suggest');
  for (const key of ['weak', 'invalid', 'empty', 'closeRunner']) expect(result[key]).toBeNull();
  expect(result.exact).toMatchObject({ name: 'Anna', similarity: 1 });
  expect(result.samePerson).toMatchObject({ name: 'Anna', personId: 'anna', similarity: 1 });
  expect(result.distinct).toMatchObject({ name: 'Anna', similarity: 1 });
});

test('conservative similarity thresholds are configurable and tolerate JSON rounding', async ({ page }) => {
  const result = await matching(page, 'threshold');
  expect(result.above?.name).toBe('Anna');
  expect(result.below).toBeNull();
  expect(result.configured).toBeNull();
  expect(result.normalized?.similarity).toBeCloseTo(1);
});
