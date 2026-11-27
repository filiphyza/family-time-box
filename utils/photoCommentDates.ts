// Windows Comments is XPComment (UTF-16LE), independent of scanner timestamps.
// Keep only precision actually written in a note and decline conflicting dates.
const monthGroups = [
  'jan january januar januara januari leden ledna lednu',
  'feb february februar februara februari unor unora unoru',
  'mar march marec marca marci brezen brezna breznu',
  'apr april aprila aprili duben dubna dubnu',
  'may maj maja maji kveten kvetna kvetnu',
  'jun june juna juni cerven cervna cervnu',
  'jul july jula juli cervenec cervence cervenci',
  'aug august augusta auguste srpen srpna srpnu',
  'sep sept september septembra septembri zari',
  'oct october oktober oktobra oktobri rijen rijna rijnu',
  'nov november novembra novembri listopad listopadu',
  'dec december decembra decembri prosinec prosince prosinci',
];
const months = new Map(monthGroups.flatMap((names, index) => names.split(' ').map(name => [name, index + 1] as const)));
const monthPattern = [...months.keys()].sort((a, b) => b.length - a.length).join('|');
const normalized = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const pad = (value: number) => String(value).padStart(2, '0');
const validDate = (year: number, month?: number, day?: number) => {
  if (year < 1 || year > 9999 || month !== undefined && (month < 1 || month > 12)) return false;
  if (day === undefined) return true;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month !== undefined && day >= 1 && day <= days[month - 1];
};

export const parsePhotoCommentDate = (comment: string): string | undefined => {
  const text = normalized(comment.replace(/\0/g, ' '));
  if (!text.trim() || text.length > 65536) return undefined;
  // An abbreviated range must not become a single year. Hyphenated ISO months
  // are handled below; en/em dashes denote ranges in handwritten captions.
  if (/\b\d{4}(?:\s*[–—]\s*|\s+[-/]\s*|\s*[-/]\s+)\d{1,4}\b/.test(text)) return undefined;
  // A short local date range (1–2.7.1968 or 6.–7.1984) must not
  // be reduced to the final day or month just because its year is shared.
  if (/\b[0-9]{1,2}\.?\s*(?:[-–—/]|and|to|az|a)\s*[0-9]{1,2}\s*[./]\s*(?:[0-9]{1,2}\s*[./]\s*)?[0-9]{4}\b/.test(text)) return undefined;
  const mentionedMonths = [...text.matchAll(new RegExp(`(?<![\\p{L}])(${monthPattern})(?![\\p{L}])`, 'gu'))].map(match => months.get(match[1]));
  if (new Set(mentionedMonths).size > 1) return undefined;
  const dayRange = new RegExp(`\\b[0-9]{1,2}(?:st|nd|rd|th)?\\.?\\s*(?:[-–—/]|and|to|az|a)\\s*[0-9]{1,2}(?:st|nd|rd|th)?\\.?\\s+(?:${monthPattern})(?![\\p{L}])`, 'gu');
  if (dayRange.test(text)) return undefined;
  const found: Array<{ start: number; end: number; value: string }> = [];
  let invalid = false;
  const add = (match: RegExpMatchArray, year: number, month?: number, day?: number) => {
    const start = match.index!, end = start + match[0].length;
    if (found.some(item => start >= item.start && end <= item.end)) return;
    if (!validDate(year, month, day)) { invalid = true; return; }
    found.push({ start, end, value: String(year).padStart(4, '0') + (month === undefined ? '' : `-${pad(month)}`) + (day === undefined ? '' : `-${pad(day)}`) });
  };
  // ISO forms are unambiguous across languages.
  for (const match of text.matchAll(/(?<![\p{L}\d])([0-9]{4})-([0-9]{1,2})(?:-([0-9]{1,2}))?(?![\p{L}\d-])/gu)) {
    add(match, Number(match[1]), Number(match[2]), match[3] === undefined ? undefined : Number(match[3]));
  }
  // Local day.month.year notes; do not salvage a year from an impossible day.
  for (const match of text.matchAll(/(?<![\p{L}\d])([0-9]{1,2})\s*\.\s*([0-9]{1,2})\s*\.\s*([0-9]{4})(?![\p{L}\d])/gu)) add(match, Number(match[3]), Number(match[2]), Number(match[1]));
  for (const match of text.matchAll(/(?<![\p{L}\d./])([0-9]{1,2})\s*[/\.]\s*([0-9]{4})(?![\p{L}\d])/gu)) add(match, Number(match[2]), Number(match[1]));
  const namedDay = new RegExp(`(?<![\\p{L}\\d])([0-9]{1,2})(?:st|nd|rd|th)?\\.?\\s+(${monthPattern})\\.?\\s+([0-9]{4})(?![\\p{L}\\d])`, 'gu');
  for (const match of text.matchAll(namedDay)) add(match, Number(match[3]), months.get(match[2]), Number(match[1]));
  const englishDay = new RegExp(`(?<![\\p{L}\\d])(${monthPattern})\\.?\\s+([0-9]{1,2})(?:st|nd|rd|th)?[,]?\\s+([0-9]{4})(?![\\p{L}\\d])`, 'gu');
  for (const match of text.matchAll(englishDay)) add(match, Number(match[3]), months.get(match[1]), Number(match[2]));
  const namedMonth = new RegExp(`(?<![\\p{L}\\d])(${monthPattern})\\.?\\s+([0-9]{4})(?![\\p{L}\\d])`, 'gu');
  for (const match of text.matchAll(namedMonth)) add(match, Number(match[2]), months.get(match[1]));
  for (const match of text.matchAll(/(?<![\p{L}\d./-])([0-9]{4})(?![\p{L}\d]|[-./]\d)/gu)) add(match, Number(match[1]));
  if (invalid || !found.length) return undefined;
  const values = [...new Set(found.map(item => item.value))].sort((a, b) => b.length - a.length);
  const mostPrecise = values[0];
  return values.every(value => value === mostPrecise || mostPrecise.startsWith(`${value}-`)) ? mostPrecise : undefined;
};

const tagBytes = (tag: unknown): Uint8Array | undefined => {
  if (tag instanceof Uint8Array) return tag;
  if (Array.isArray(tag) && tag.every(value => typeof value === 'number' && value >= 0 && value <= 255)) return new Uint8Array(tag);
};
const clean = (text: string) => text.replace(/\0+$/g, '').trim();
const unicodeComment = (bytes: Uint8Array, fallback = 'utf-16le') => {
  const encoding = bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : fallback;
  return clean(new TextDecoder(encoding).decode(bytes));
};
const exifComment = (tag: unknown) => {
  const bytes = tagBytes(tag);
  if (!bytes || bytes.length < 8) return '';
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 8));
  if (header.startsWith('ASCII')) return clean(new TextDecoder('utf-8').decode(bytes.subarray(8)));
  if (header.startsWith('UNICODE')) {
    const body = bytes.subarray(8);
    return unicodeComment(body, body[0] === 0 && body[1] !== 0 ? 'utf-16be' : 'utf-16le');
  }
  return '';
};

export const tiffCommentDate = (page: Record<string, unknown>): string | undefined => {
  const xp = tagBytes(page.t40092);
  // Windows' explicitly entered comment takes precedence over generic scanner
  // descriptions. No TIFF/EXIF DateTime field is a source for a photo date.
  const windowsComment = xp?.length ? unicodeComment(xp) : '';
  if (windowsComment) return parsePhotoCommentDate(windowsComment);
  const exif = page.exifIFD && typeof page.exifIFD === 'object' ? page.exifIFD as Record<string, unknown> : page;
  const userComment = exifComment(exif.t37510);
  if (userComment) return parsePhotoCommentDate(userComment);
  const description = Array.isArray(page.t270) && typeof page.t270[0] === 'string' ? clean(page.t270[0]) : '';
  // Some TIFF writers put a date in ImageDescription instead of XPComment.
  // Only accept a standalone date here; scanner descriptions are often dated.
  const remainder = normalized(description).replace(new RegExp(`\\b(?:${monthPattern})\\b`, 'gu'), '').replace(/[\d\s.,/-]/g, '');
  return description && !remainder ? parsePhotoCommentDate(description) : undefined;
};



