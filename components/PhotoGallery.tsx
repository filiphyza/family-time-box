import React, { useEffect, useId, useRef, useState } from 'react';
import type { Photo, Language } from '../types';
import { translations } from '../utils/translations';
import { PhotoCard } from './PhotoCard';

const BATCH_SIZE = 24;

interface PhotoGalleryProps {
  photos: Photo[];
  onPhotoClick: (photo: Photo) => void;
  language: Language;
}

export const PhotoGallery: React.FC<PhotoGalleryProps> = ({ photos, onPhotoClick, language }) => {
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const gridId = useId();
  const t = translations[language];
  const shownCount = Math.min(visibleCount, photos.length);
  const hasMore = shownCount < photos.length;

  useEffect(() => {
    if (!hasMore || !loadMoreRef.current || typeof IntersectionObserver === 'undefined') return;
    // Start the next batch before the reader reaches the end of the current one.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(count => Math.min(count + BATCH_SIZE, photos.length));
      }
    }, { rootMargin: '600px 0px' });
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, visibleCount, photos.length]);

  return (
    <div className="space-y-6">
      <div
        id={gridId}
        className="grid gap-6 animate-in fade-in duration-500"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 286px), 1fr))' }}
      >
        {photos.slice(0, shownCount).map(photo => (
          <PhotoCard key={photo.id} photo={photo} onClick={onPhotoClick} language={language} />
        ))}
      </div>
      <div ref={loadMoreRef} className="flex flex-col items-center gap-3 py-4">
        <p aria-live="polite" aria-label={t.galleryProgress} className="text-sm text-slate-400">
          {t.galleryProgress}: {shownCount} / {photos.length}
        </p>
        {hasMore && (
          <button
            type="button"
            aria-controls={gridId}
            onClick={() => setVisibleCount(count => Math.min(count + BATCH_SIZE, photos.length))}
            className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sepia-400"
          >
            {t.galleryLoadMore}
          </button>
        )}
      </div>
    </div>
  );
};
