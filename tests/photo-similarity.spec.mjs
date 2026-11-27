import { test, expect } from '@playwright/test';

async function compare(page, scenario) {
  await page.goto('/');
  return page.evaluate(async scenario => {
    const { findSimilarPhotos } = await import('/services/photoSimilarity.ts');
    const picture = (kind, shift = 0) => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const c = canvas.getContext('2d');
      c.fillStyle = '#b8ac8f'; c.fillRect(0, 0, 320, 240);
      if (kind === 'plain') return canvas.toDataURL();
      c.translate(shift, 0);
      if (kind === 'yard') {
        c.fillStyle = '#ded2b8'; c.fillRect(0, 0, 320, 146);
        c.fillStyle = '#7d795c'; c.fillRect(0, 146, 320, 94);
        c.fillStyle = '#a58b65'; c.fillRect(124, 71, 105, 102);
        c.fillStyle = '#463f32'; c.beginPath(); c.moveTo(110, 74); c.lineTo(177, 23); c.lineTo(243, 74); c.fill();
        c.fillStyle = '#4c4b3e'; c.fillRect(141, 100, 24, 24); c.fillRect(189, 104, 24, 24); c.fillRect(168, 133, 23, 40);
        c.fillStyle = '#65583b'; c.fillRect(49, 55, 12, 118);
        c.fillStyle = '#565f3a'; c.beginPath(); c.arc(55, 51, 38, 0, 7); c.fill();
        c.fillStyle = '#302d26'; c.beginPath(); c.arc(276, 122, 12, 0, 7); c.fill(); c.fillRect(268, 134, 16, 48);
        c.fillStyle = '#e5d9ba'; c.fillRect(268, 139, 16, 20);
        c.strokeStyle = '#4a4534'; c.lineWidth = 4;
        for (let x = 10; x < 310; x += 28) { c.beginPath(); c.moveTo(x, 200); c.lineTo(x + 18, 220); c.stroke(); }
      } else {
        for (let row = 0; row < 8; row++) for (let col = 0; col < 10; col++) {
          c.fillStyle = ['#ded2b8', '#7d795c', '#a58b65', '#463f32'][(row * 11 + col * 3 + (row * col) % 3) % 4];
          c.fillRect(col * 32, row * 30, 32, 30);
        }
      }
      return canvas.toDataURL();
    };
    const photo = (id, kind, extra = {}) => ({ id, originalUrl: picture(kind), fileName: `${id}.jpg`, dateOfPhoto: '', uploadDate: 1, ...extra });
    if (scenario === 'scenes') {
      const target = photo('img100', 'yard', { restoredUrl: picture('tiles'), thumbnailUrl: picture('plain'), thumbnailSource: 'restored' });
      const references = [
        { ...photo('img101', 'yard', { dateOfPhoto: '1968-07', location: 'Garden' }), originalUrl: picture('yard', 2) },
        photo('img102', 'tiles', { dateOfPhoto: '1984' }),
        photo('img103', 'tiles', { restoredUrl: picture('yard'), dateOfPhoto: '1990' }),
        photo('no-metadata', 'yard'),
        target,
      ];
      const progress = [];
      return { ...await findSimilarPhotos(target, references, { onProgress: (done, total) => progress.push([done, total]) }), progress };
    }
    if (scenario === 'plain') return findSimilarPhotos(photo('img100', 'plain'), [photo('img101', 'plain', { dateOfPhoto: '1968' })]);
    if (scenario === 'failures') {
      const target = photo('target', 'yard');
      const result = await findSimilarPhotos(target, [photo('okay', 'yard', { dateOfPhoto: '1970' }), photo('broken', 'yard', { originalUrl: 'data:image/png;base64,YmFk', location: 'Garden' })]);
      const controller = new AbortController(); controller.abort();
      let aborted;
      try { await findSimilarPhotos(target, [], { signal: controller.signal }); } catch (error) { aborted = error.name; }
      const during = new AbortController(); let duringAbort;
      try { await findSimilarPhotos(target, [photo('first', 'yard', { dateOfPhoto: '1970' }), photo('second', 'yard', { dateOfPhoto: '1971' })], { signal: during.signal, onProgress: done => { if (done === 1) during.abort(); } }); }
      catch (error) { duringAbort = error.name; }
      return { result, aborted, duringAbort };
    }
    if (scenario === 'replacement') {
      const target = photo('target', 'yard');
      const reference = photo('reference', 'yard', { dateOfPhoto: '1970' });
      const before = await findSimilarPhotos(target, [reference]);
      const after = await findSimilarPhotos({ ...target, originalUrl: picture('tiles') }, [reference]);
      return { before: before.matches.length, after: after.matches.length };
    }
  }, scenario);
}

test('local comparison finds related compositions and ignores restored images, filename proximity and matching format alone', async ({ page }) => {
  const result = await compare(page, 'scenes');
  expect(result.compared).toBe(3); expect(result.skipped).toBe(0);
  expect(result.matches.map(match => match.photoId)).toEqual(['img101']);
  expect(result.matches[0]).toMatchObject({ confidence: 'possible', dateEvidence: true, locationEvidence: true });
  expect(result.matches[0].reasons).toContain('composition');
  expect(result.rankedPhotoIds[0]).toBe('img101');
  expect(result.progress[0]).toEqual([0, 3]); expect(result.progress.at(-1)).toEqual([3, 3]);
});

test('uniform photos cannot establish date or location even with identical color, format and adjacent scan numbers', async ({ page }) => {
  const result = await compare(page, 'plain');
  expect(result.compared).toBe(1); expect(result.matches).toEqual([]);
  expect(result.rankedPhotoIds).toEqual(['img101']);
});

test('unreadable references are skipped and cancellation does not return stale results', async ({ page }) => {
  const { result, aborted, duringAbort } = await compare(page, 'failures');
  expect(result.compared).toBe(1); expect(result.skipped).toBe(1);
  expect(result.matches.map(match => match.photoId)).toEqual(['okay']);
  expect(aborted).toBe('AbortError'); expect(duringAbort).toBe('AbortError');
});

test('replacing an original invalidates its visual descriptor', async ({ page }) => {
  expect(await compare(page, 'replacement')).toEqual({ before: 1, after: 0 });
});

test('suggestions use only current source metadata, preserve precision, and group places without inventing fields', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { buildMetadataSuggestions } = await import('/utils/photoSuggestions.ts');
    const target = { id: 'target', dateOfPhoto: '', location: '', uploadDate: 1 };
    const refs = [target, { id: 'year', dateOfPhoto: '1968', location: '  Garden   Senica  ' }, { id: 'month', dateOfPhoto: '1968-07', location: 'garden senica' },
      { id: 'exact', dateOfPhoto: '1970-10-23', location: '' }, { id: 'invalid', dateOfPhoto: '1970-02-31', location: '' },
      { id: 'only-place', dateOfPhoto: '', location: 'Kitchen' }, { id: 'only-month', dateOfPhoto: '--07', location: '' }];
    const matches = [...refs, { id: 'deleted' }].map((photo, index) => ({ photoId: photo.id, similarity: 0.97 - index * 0.01, confidence: 'strong', dateEvidence: true, locationEvidence: true, reasons: ['composition', 'format'] }));
    const grouped = buildMetadataSuggestions(target, refs, matches, 'visual');
    const current = buildMetadataSuggestions({ ...target, dateOfPhoto: '1968', location: 'Garden Senica' }, refs, matches, 'visual');
    const fieldSpecific = buildMetadataSuggestions(target, refs, [{ ...matches[1], dateEvidence: false }], 'ai');
    return { grouped, current, fieldSpecific, unchanged: refs[1].location };
  });
  expect(result.grouped.dates.map(item => item.value)).toEqual(['1968', '1968-07', '1970-10-23']);
  expect(result.grouped.locations[0]).toMatchObject({ value: 'Garden Senica', sourcePhotoIds: ['year', 'month'], confidence: 'possible' });
  expect(result.grouped.dates.every(item => item.confidence === 'possible')).toBe(true);
  expect(result.grouped.matches.some(item => ['target', 'deleted'].includes(item.photoId))).toBe(false);
  expect(result.current.dates.map(item => item.value)).toEqual(['1968-07', '1970-10-23']);
  expect(result.current.locations.map(item => item.value)).toEqual(['Kitchen']);
  expect(result.fieldSpecific.dates).toEqual([]);
  expect(result.fieldSpecific.locations[0].value).toBe('Garden Senica');
  expect(result.unchanged).toBe('  Garden   Senica  ');
});

test('equally plausible conflicting dates and places stay tentative, and malformed evidence is ignored', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { buildMetadataSuggestions } = await import('/utils/photoSuggestions.ts');
    const refs = [{ id: 'a', dateOfPhoto: '1968', location: 'Senica' }, { id: 'b', dateOfPhoto: '1978', location: 'Prague' }];
    const match = { similarity: 0.95, confidence: 'strong', dateEvidence: true, locationEvidence: true, reasons: ['scene'] };
    return buildMetadataSuggestions({ id: 'target', dateOfPhoto: '' }, refs, [{ ...match, photoId: 'a' }, { ...match, photoId: 'b', similarity: 0.94 },
      { ...match, photoId: 'a', similarity: NaN }, { ...match, photoId: 'a', reasons: [] }], 'ai');
  });
  expect(result.dates).toHaveLength(2); expect(result.locations).toHaveLength(2);
  expect([...result.dates, ...result.locations].every(item => item.confidence === 'possible')).toBe(true);
});
