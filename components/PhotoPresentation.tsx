import React from 'react';
import { Photo, Language } from '../types';
import { translations } from '../utils/translations';
import { X, Calendar, MapPin, Edit3 } from 'lucide-react';
import { PhotoNavigation, type PhotoNavigationProps } from './PhotoNavigation';
import { formatPartialDate } from '../utils/partialDates';
import { AiSuggestionBadge, isAiMetadata, isAiPerson } from './AiSuggestionBadge';

interface PhotoPresentationProps {
  photo: Photo;
  language: Language;
  onClose: () => void;
  onEdit: () => void;
  navigation: PhotoNavigationProps;
}

export const PhotoPresentation: React.FC<PhotoPresentationProps> = ({ photo, language, onClose, onEdit, navigation }) => {
  const t = translations[language];
  const displayImage = photo.restoredUrl || photo.originalUrl;
  
  const niceDate = photo.dateOfPhoto ? formatPartialDate(photo.dateOfPhoto, language) : null;

  return (
    <div role="dialog" aria-modal="true" aria-label={t.photoViewer} className="fixed inset-0 z-50 bg-black animate-in fade-in duration-300 flex items-center justify-center overflow-hidden">
      <PhotoNavigation {...navigation} />
      
      {/* Background Ambience */}
      <div 
        className="absolute inset-0 z-0 bg-cover bg-center blur-3xl opacity-40 scale-110"
        style={{ backgroundImage: `url(${displayImage})` }}
      />
      <div className="absolute inset-0 z-0 bg-black/40" />

      {/* Main Container */}
      <div className="relative z-10 w-full h-full flex flex-col max-w-7xl mx-auto p-4 md:p-8 gap-4">
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
          <div className="flex gap-3">
            <button 
                onClick={onEdit}
                type="button"
                className="bg-black/40 hover:bg-black/60 backdrop-blur-md text-white px-4 py-2 rounded-full border border-white/10 flex items-center gap-2 transition-all hover:scale-105"
            >
                <Edit3 size={16} />
                <span className="text-sm font-medium">{t.enhanceEdit}</span>
            </button>
            <button 
                onClick={onClose}
                type="button"
                aria-label={t.close}
                className="bg-black/40 hover:bg-red-500/20 backdrop-blur-md text-white p-2 rounded-full border border-white/10 transition-colors"
            >
                <X size={20} />
            </button>
          </div>
        </div>
        <div className="flex flex-1 min-h-0 flex-col md:flex-row gap-6 md:gap-8 overflow-y-auto">
        {/* Left: The Photo */}
        <div className="min-h-0 shrink-0 md:shrink md:flex-1 flex items-center justify-center relative">
            <div className="relative group max-h-full max-w-full">
                <img 
                    src={displayImage} 
                    alt={photo.description}
                    className="max-h-[55vh] md:max-h-[calc(100dvh-10rem)] max-w-full object-contain shadow-2xl rounded-sm border-[6px] border-white/90"
                />
                
                {/* Visual indicator if it is restored */}
                {photo.restoredUrl && (
                    <div className="absolute bottom-4 left-4 bg-black/50 backdrop-blur text-white text-xs px-2 py-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                        {t.digitallyRestored}
                    </div>
                )}
            </div>
        </div>

        {/* Right/Bottom: The Memory (Metadata) */}
        <div className="w-full md:w-[350px] lg:w-[400px] shrink-0 flex flex-col pb-4 md:overflow-y-auto text-white/90 animate-in slide-in-from-right-8 duration-500 delay-100">
            <div className="bg-black/30 backdrop-blur-xl p-8 rounded-2xl border border-white/10 shadow-xl space-y-6">
                
                {/* Header: Date & Location */}
                <div className="space-y-1">
                    {niceDate ? (
                        <h2 className="font-serif text-3xl md:text-4xl text-sepia-100 leading-tight">
                            {niceDate}
                            {isAiMetadata(photo, 'dateOfPhoto') && <span className="ml-2 inline-flex align-middle"><AiSuggestionBadge language={language} /></span>}
                        </h2>
                    ) : (
                        <h2 className="font-serif text-2xl text-white/50 italic">{t.dateUnknown}</h2>
                    )}

                    {photo.location && (
                        <div className={`flex flex-wrap items-center gap-2 uppercase tracking-widest text-sm font-medium pt-2 ${isAiMetadata(photo, 'location') ? 'text-violet-200' : 'text-sepia-400'}`}>
                            <MapPin size={14} />
                            {photo.location}
                            {isAiMetadata(photo, 'location') && <AiSuggestionBadge language={language} />}
                        </div>
                    )}
                </div>

                <div className="w-12 h-0.5 bg-sepia-500/50" />

                {/* Description */}
                {photo.description ? (
                    <p className="font-serif text-lg leading-relaxed text-slate-200 italic">
                        "{photo.description}"
                    </p>
                ) : (
                    <p className="text-slate-400 text-sm italic">{t.noDescription}</p>
                )}

                {/* People */}
                {photo.people && photo.people.length > 0 && (
                    <div className="pt-4">
                        <p className="text-xs uppercase tracking-wider text-slate-400 mb-2 font-semibold">{t.inThisMemory}</p>
                        <div className="flex flex-wrap gap-2">
                            {photo.people.map(p => (
                                <span key={p} className={`inline-flex flex-wrap items-center gap-2 px-3 py-1 rounded-full text-sm border ${isAiPerson(photo, p) ? 'border-dashed border-violet-400 bg-violet-950/40 text-violet-100' : 'bg-white/10 border-white/5'}`}>
                                    {p}
                                    {isAiPerson(photo, p) && <AiSuggestionBadge language={language} compact />}
                                </span>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>

        </div>
      </div>
    </div>
  );
};
