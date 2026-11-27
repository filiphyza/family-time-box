import type { Photo } from '../types';
import { isPartialDate } from './partialDates';

// Sorting uses the first possible day solely as a consistent ordering key;
// the stored date and the displayed precision are left untouched.
export const photoDateSortValue = (photo: Pick<Photo, 'dateOfPhoto' | 'uploadDate'>): number => {
  const value = photo.dateOfPhoto;
  if (!isPartialDate(value) || value.startsWith('--')) return Number.POSITIVE_INFINITY;
  const [year, month = 1, day = 1] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
};

export const comparePhotoDates = (a: Pick<Photo, 'dateOfPhoto' | 'uploadDate'>, b: Pick<Photo, 'dateOfPhoto' | 'uploadDate'>): number => {
  const dateA = photoDateSortValue(a), dateB = photoDateSortValue(b);
  // Undated photos follow every dated photo. Keep upload order for equal dates,
  // including two unknown dates, without subtracting Infinity from itself.
  return dateA === dateB ? (b.uploadDate || 0) - (a.uploadDate || 0) : dateA - dateB;
};
