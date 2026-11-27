import type { Language } from '../types';

export type DatePrecision = 'none' | 'year' | 'month' | 'date' | 'monthOnly';
export interface PartialDateDraft { precision: DatePrecision; year: string; month: string; day: string }
const monthDays = (year: number, month: number) => [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

export const isPartialDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (/^--(0[1-9]|1[0-2])$/.test(value)) return true;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  return year >= 1 && (!match[2] || month >= 1 && month <= 12) && (!match[3] || day >= 1 && day <= monthDays(year, month));
};
const dateBounds = (value?: string): [number, number] | null => {
  if (!value || value.startsWith('--') || !isPartialDate(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return [year * 10000 + (month || 1) * 100 + (day || 1), year * 10000 + (month || 12) * 100 + (day || monthDays(year, month || 12))];
};
export const datesInOrder = (birth?: string, death?: string) => {
  const born = dateBounds(birth), died = dateBounds(death);
  return !born || !died || born[0] <= died[1];
};
export const partialDateDraft = (value?: string): PartialDateDraft => {
  if (!value) return { precision: 'none', year: '', month: '', day: '' };
  if (value.startsWith('--')) return { precision: 'monthOnly', year: '', month: String(Number(value.slice(2))), day: '' };
  const [year, month, day] = value.split('-');
  return { precision: day ? 'date' : month ? 'month' : 'year', year: String(Number(year)), month: month ? String(Number(month)) : '', day: day ? String(Number(day)) : '' };
};
export const serializePartialDate = (draft: PartialDateDraft): string | undefined => {
  const { precision, year, month, day } = draft;
  if (precision === 'none') return undefined;
  if (precision === 'monthOnly') return `--${month.padStart(2, '0')}`;
  const parts = [year.padStart(4, '0')];
  if (precision === 'month' || precision === 'date') parts.push(month.padStart(2, '0'));
  if (precision === 'date') parts.push(day.padStart(2, '0'));
  return parts.join('-');
};
export const formatPartialDate = (value: string, language: Language): string => {
  if (!isPartialDate(value)) return value;
  const locale = language === 'sk' ? 'sk' : 'en';
  if (value.startsWith('--')) return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, Number(value.slice(2)) - 1, 1)));
  if (value.length === 4) return value;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day || 1); date.setUTCHours(0, 0, 0, 0);
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', ...(day ? { day: 'numeric' as const } : {}), timeZone: 'UTC' }).format(date);
};

// Captions use the same localized date wording as the UI, while the stored
// date and its precision remain unchanged.
export const applyPhotoDescriptionDate = (description: string, value: string | undefined, language: Language): string => {
  if (!isPartialDate(value)) return description;
  const formatted = formatPartialDate(value, language);
  if (formatted === value) return description;
  const pattern = new RegExp('(?<![\\p{L}\\p{N}-])' + value + '(?![\\p{L}\\p{N}-])', 'gu');
  return description.replace(pattern, () => formatted);
};
