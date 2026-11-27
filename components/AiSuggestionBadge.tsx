import React from 'react';
import { Sparkles } from 'lucide-react';
import type { Language, Photo } from '../types';
import { personNameKey } from '../utils/people';
import { aiSuggestionTranslations } from '../utils/aiSuggestionTranslations';

export const isAiMetadata = (photo: Photo, field: 'dateOfPhoto' | 'location') =>
  Boolean(photo.aiMetadata?.[field]?.value && photo.aiMetadata[field]?.value === photo[field]);
export const isAiPerson = (photo: Photo, name: string) =>
  (photo.faceTags || []).some(tag => tag.aiSuggested && personNameKey(tag.name) === personNameKey(name));
export const hasAiSuggestions = (photo: Photo) =>
  isAiMetadata(photo, 'dateOfPhoto') || isAiMetadata(photo, 'location') || (photo.faceTags || []).some(tag => tag.aiSuggested);

export const AiSuggestionBadge: React.FC<{ language: Language; compact?: boolean }> = ({ language, compact = false }) => {
  const t = aiSuggestionTranslations[language];
  return <span aria-label={t.badge} title={t.reviewHelp} className="inline-flex shrink-0 items-center gap-1 rounded border border-dashed border-violet-400/80 bg-violet-950/80 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-violet-200">
    <Sparkles size={11} aria-hidden="true" />{compact ? 'AI' : t.badge}
  </span>;
};
