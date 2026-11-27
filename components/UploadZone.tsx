import React, { useRef } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { Language } from '../types';
import { translations } from '../utils/translations';

export interface UploadProgress {
  total: number;
  completed: number;
  saved: number;
  failed: number;
  currentFile: string;
  phase: 'reading' | 'converting' | 'saving' | 'refreshing';
}

export const UploadProgressPanel: React.FC<{ progress: UploadProgress; language: Language }> = ({ progress, language }) => {
  const t = translations[language];
  const percent = Math.round(progress.completed / progress.total * 100);
  const phase = progress.phase === 'reading' ? t.uploadReading
    : progress.phase === 'converting' ? t.uploadConverting
    : progress.phase === 'saving' ? t.uploadSaving : t.uploadFinishing;
  return (
    <div className="w-full max-w-xl space-y-3 text-left">
      <div role="status" aria-live="polite" aria-atomic="true" className="space-y-1">
        <p className="font-medium text-sepia-100">{t.uploadProcessing} {Math.min(progress.completed + 1, progress.total)} / {progress.total}</p>
        <p className="text-sm text-slate-300 break-all">{phase}{progress.currentFile ? `: ${progress.currentFile}` : ''}</p>
      </div>
      <div role="progressbar" aria-label={t.uploadProgressLabel} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed} aria-valuetext={`${progress.completed} / ${progress.total}`} className="h-2.5 overflow-hidden rounded-full bg-slate-700">
        <div className="h-full rounded-full bg-sepia-400 transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-400">
        <span>{t.uploadSaved}: {progress.saved}{progress.failed > 0 ? ` · ${t.uploadFailedCount}: ${progress.failed}` : ''}</span>
        <span>{percent}%</span>
      </div>
    </div>
  );
};

interface UploadZoneProps {
  onFileSelect: (files: FileList) => void;
  language: Language;
  disabled?: boolean;
  progress?: UploadProgress | null;
}

export const UploadZone: React.FC<UploadZoneProps> = ({ onFileSelect, language, disabled = false, progress }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const t = translations[language];
  const busy = disabled || Boolean(progress);
  const handleClick = () => { if (!busy) inputRef.current?.click(); };
  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!busy && event.dataTransfer.files.length > 0) onFileSelect(event.dataTransfer.files);
  };

  return (
    <div
      role={busy ? 'group' : 'button'}
      aria-label={t.dropZoneTitle}
      aria-disabled={busy}
      aria-busy={busy}
      tabIndex={busy ? -1 : 0}
      onClick={handleClick}
      onKeyDown={event => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); handleClick(); }
      }}
      onDrop={handleDrop}
      onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}
      className={`border-2 rounded-2xl p-8 md:p-12 flex flex-col items-center justify-center text-center transition-colors ${busy
        ? 'border-solid border-sepia-700/70 bg-slate-800/60 cursor-wait'
        : 'border-dashed border-slate-600 hover:bg-slate-800/50 hover:border-sepia-500 cursor-pointer group'}`}
    >
      <input
        type="file"
        multiple
        accept="image/*,.tif,.tiff,image/tiff,image/x-tiff"
        disabled={busy}
        className="hidden"
        ref={inputRef}
        onChange={event => {
          if (!busy && event.target.files) onFileSelect(event.target.files);
          event.target.value = '';
        }}
      />
      <div className={`w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mb-6 shadow-lg ${busy ? '' : 'group-hover:scale-110 transition-transform group-hover:bg-slate-700'}`}>
        {busy ? <Loader2 aria-hidden="true" className="animate-spin text-sepia-400" size={32} /> : <Upload aria-hidden="true" className="text-sepia-400" size={32} />}
      </div>
      <h3 className="text-xl font-semibold text-white mb-2">{progress ? t.uploadInProgress : busy ? t.uploadLoadingArchive : t.dropZoneTitle}</h3>
      {progress ? (
        <>
          <p className="text-slate-400 text-sm mb-6 max-w-md">{t.uploadWait}</p>
          <UploadProgressPanel progress={progress} language={language} />
        </>
      ) : <p className="text-slate-400 max-w-md">{busy ? t.uploadWait : t.dropZoneDesc}</p>}
    </div>
  );
};
