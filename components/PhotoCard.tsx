import React from 'react';
import { Photo, Language } from '../types';
import { translations } from '../utils/translations';
import { hasThumbnail } from '../utils/thumbnails';
import { formatPartialDate } from '../utils/partialDates';
import { Calendar, Users, Tag as TagIcon, Loader2, Sparkles } from 'lucide-react';
import { AiSuggestionBadge, hasAiSuggestions, isAiMetadata, isAiPerson } from './AiSuggestionBadge';

interface PhotoCardProps {
  photo: Photo;
  onClick: (photo: Photo) => void;
  language: Language;
}

export const PhotoCard: React.FC<PhotoCardProps> = ({ photo, onClick, language }) => {
  const t = translations[language];
  return (
    <div 
      onClick={() => onClick(photo)}
      className="group relative bg-slate-800 rounded-xl overflow-hidden shadow-lg hover:shadow-2xl transition-all duration-300 cursor-pointer border border-slate-700 hover:border-sepia-400"
    >
      {/* Image Container */}
      <div className="aspect-[4/5] relative overflow-hidden bg-slate-900">
        <img 
          loading="lazy"
          decoding="async"
          src={hasThumbnail(photo) ? photo.thumbnailUrl : (photo.restoredUrl || photo.originalUrl)}
          onError={event => {
            const fullImage = photo.restoredUrl || photo.originalUrl;
            if (event.currentTarget.src !== fullImage) event.currentTarget.src = fullImage;
          }} 
          alt={photo.description || "Family Photo"}
          className={`w-full h-full object-cover transition-transform duration-700 group-hover:scale-105 ${photo.isRestoring ? 'opacity-50' : 'opacity-100'}`}
        />
        
        {/* Status Badge */}
        <div className="absolute top-3 right-3 left-3 flex flex-wrap justify-end gap-2">
            {hasAiSuggestions(photo) && <AiSuggestionBadge language={language} />}
            {photo.isRestoring && (
                <div className="bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1 animate-pulse shadow-lg">
                    <Loader2 size={12} className="animate-spin" />
                    {t.restoring}
                </div>
            )}
            {photo.restoredUrl && !photo.isRestoring && (
                <div className="bg-sepia-500 text-slate-900 text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1 shadow-lg">
                    <Sparkles size={12} />
                    {t.restoredByAi}
                </div>
            )}
        </div>

        {/* Date Overlay */}
        {photo.dateOfPhoto && (
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 translate-y-full group-hover:translate-y-0 transition-transform duration-300">
                <p className="text-white font-medium flex items-center gap-2">
                    <Calendar size={14} />
                    {formatPartialDate(photo.dateOfPhoto, language)}
                    {isAiMetadata(photo, 'dateOfPhoto') && <AiSuggestionBadge language={language} compact />}
                </p>
            </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        {photo.description ? (
            <p className="text-sm text-slate-300 line-clamp-2 leading-relaxed">
                {photo.description}
            </p>
        ) : (
            <p className="text-sm text-slate-500 italic">{t.noDescription}</p>
        )}

        <div className="flex flex-wrap gap-2">
            {photo.people.slice(0, 3).map((person, idx) => (
                <span key={idx} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border ${isAiPerson(photo, person) ? 'border-dashed border-violet-400 bg-violet-950/40 text-violet-100' : 'bg-slate-700 text-slate-200 border-slate-600'}`}>
                    <Users size={10} />
                    {person}
                    {isAiPerson(photo, person) && <AiSuggestionBadge language={language} compact />}
                </span>
            ))}
            {photo.people.length > 3 && (
                <span className="text-xs text-slate-500 self-center">+{photo.people.length - 3}</span>
            )}
        </div>

        <div className="flex flex-wrap gap-2">
            {photo.tags.slice(0, 2).map((tag, idx) => (
                <span key={idx} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sepia-900/40 text-sepia-300 text-xs border border-sepia-900/50">
                    <TagIcon size={10} />
                    {tag}
                </span>
            ))}
        </div>
      </div>
    </div>
  );
};
