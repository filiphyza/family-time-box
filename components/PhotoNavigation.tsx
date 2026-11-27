import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Language } from '../types';
import { translations } from '../utils/translations';

export interface PhotoNavigationProps {
  index: number;
  total: number;
  language: Language;
  onPrevious: () => void;
  onNext: () => void;
  activeEdge: 'left' | 'right' | null;
  disabled?: boolean;
}

// Keep this state in App so an arrow stays revealed when navigation remounts a photo.
export const useViewportEdge = (): PhotoNavigationProps['activeEdge'] => {
  const [edge, setEdge] = useState<PhotoNavigationProps['activeEdge']>(null);

  useEffect(() => {
    let lastX: number | null = null;
    const updateEdge = () => {
      const margin = Math.min(80, window.innerWidth * 0.15);
      setEdge(lastX === null ? null : lastX <= margin ? 'left' : lastX >= window.innerWidth - margin ? 'right' : null);
    };
    const handlePointerMove = (event: PointerEvent) => {
      lastX = event.pointerType === 'touch' ? null : event.clientX;
      updateEdge();
    };
    const clearEdge = () => { lastX = null; setEdge(null); };
    const handlePointerOut = (event: PointerEvent) => { if (!event.relatedTarget) clearEdge(); };
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerout', handlePointerOut);
    window.addEventListener('blur', clearEdge);
    window.addEventListener('resize', updateEdge);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerout', handlePointerOut);
      window.removeEventListener('blur', clearEdge);
      window.removeEventListener('resize', updateEdge);
    };
  }, []);

  return edge;
};

export const PhotoNavigation: React.FC<PhotoNavigationProps> = ({ index, total, language, onPrevious, onNext, activeEdge, disabled = false }) => {
  const t = translations[language];
  const hasPrevious = index > 0;
  const hasNext = index >= 0 && index < total - 1;
  const [showTouchControls, setShowTouchControls] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(hover: none), (pointer: coarse)');
    const update = () => setShowTouchControls(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (disabled || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="slider"], [role="spinbutton"]')) return;
      if (event.key === 'ArrowLeft' && hasPrevious) {
        event.preventDefault();
        onPrevious();
      } else if (event.key === 'ArrowRight' && hasNext) {
        event.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [disabled, hasPrevious, hasNext, onPrevious, onNext]);

  const arrowClasses = (available: boolean, edge: 'left' | 'right') => {
    const revealed = available && !disabled && (activeEdge === edge || showTouchControls);
    return `fixed top-1/2 -translate-y-1/2 flex h-16 w-11 items-center justify-center rounded-full bg-black/30 text-white/80 backdrop-blur-sm transition-opacity duration-200 hover:bg-black/50 hover:text-white focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-sepia-400 motion-reduce:transition-none ${revealed ? `${showTouchControls ? 'opacity-40' : 'opacity-100'} pointer-events-auto` : 'opacity-0 pointer-events-none'}`;
  };

  return (
    <div role="group" aria-label={t.photoNavigation} className="pointer-events-none fixed inset-0 z-[60]">
      <button type="button" onClick={onPrevious} disabled={disabled || !hasPrevious} aria-label={t.previousPhoto} title={`${t.previousPhoto} (←)`} className={`${arrowClasses(hasPrevious, 'left')} left-2 sm:left-4`}>
        <ChevronLeft size={28} aria-hidden="true" />
      </button>
      <span aria-label={t.photoPosition} aria-live="polite" aria-atomic="true" className="sr-only">{index + 1} / {total}</span>
      <button type="button" onClick={onNext} disabled={disabled || !hasNext} aria-label={t.nextPhoto} title={`${t.nextPhoto} (→)`} className={`${arrowClasses(hasNext, 'right')} right-2 sm:right-4`}>
        <ChevronRight size={28} aria-hidden="true" />
      </button>
    </div>
  );
};
