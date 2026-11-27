import React, { useEffect, useRef } from 'react';
import { ListTodo, X } from 'lucide-react';
import type { Language } from '../types';
import type { useBackgroundFaceRecognition } from '../hooks/useBackgroundFaceRecognition';
import type { useBackgroundPhotoSimilarity } from '../hooks/useBackgroundPhotoSimilarity';
import { translations } from '../utils/translations';
import { photoSuggestionTranslations } from '../utils/photoSuggestionTranslations';

export interface PhotoSimilarityJob {
  fileName: string;
  status: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled' | 'waiting';
  method: 'visual' | 'ai';
  completed: number;
  total: number;
  skipped: number;
}

export const JobsButton: React.FC<{ language: Language; onClick: () => void; expanded: boolean }> = ({ language, onClick, expanded }) => (
  <button type="button" onClick={onClick} title={translations[language].jobs} aria-label={translations[language].jobs}
    aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? 'jobs-popup' : undefined}
    className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sepia-400">
    <ListTodo size={20} aria-hidden="true" />
  </button>
);

interface JobsPopupProps {
  language: Language;
  recognition: ReturnType<typeof useBackgroundFaceRecognition>;
  similarity: PhotoSimilarityJob | null;
  similarityIndexing: ReturnType<typeof useBackgroundPhotoSimilarity>;
  waitingForArchive: boolean;
  onClose: () => void;
}

export const JobsPopup: React.FC<JobsPopupProps> = ({ language, recognition, similarity, similarityIndexing, waitingForArchive, onClose }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const t = translations[language];
  const suggestions = photoSuggestionTranslations[language];

  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => {
      element.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  const faceStatus = recognition.clearing ? t.recognitionClearing : recognition.paused ? t.recognitionPaused
    : waitingForArchive ? t.recognitionWaiting : recognition.running ? t.recognitionProgress
    : recognition.completed + recognition.failed < recognition.total ? t.recognitionQueued : t.recognitionReady;
  const similarityStatus = !similarity ? ''
    : similarity.status === 'idle' ? suggestions.noReferences
    : similarity.status === 'waiting' ? t.similarityWaiting
    : similarity.status === 'running' ? similarity.method === 'ai' ? suggestions.comparingAi : suggestions.loading
    : similarity.status === 'failed' ? similarity.method === 'ai' ? suggestions.aiFailed : suggestions.failed
    : similarity.status === 'cancelled' ? t.similarityCancelled
    : similarity.method === 'ai' ? suggestions.ai : suggestions.local;
  const indexingStatus = waitingForArchive ? t.recognitionWaiting : similarityIndexing.paused ? t.similarityScanPaused
    : similarityIndexing.running ? t.similarityScanning
    : similarityIndexing.completed + similarityIndexing.failed < similarityIndexing.total ? t.similarityScanQueued
    : similarityIndexing.failed > 0 ? t.similarityScanIncomplete : t.similarityScanReady;

  return <dialog ref={dialog} id="jobs-popup" aria-label={t.jobs}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key !== 'Tab') return;
      const buttons = (event.currentTarget as HTMLDialogElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onClick={event => { if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    } }}
    className="fixed inset-auto right-4 top-20 m-0 max-h-[calc(100dvh-6rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-0 text-slate-200 shadow-2xl backdrop:bg-black/50 sm:right-6 lg:right-8">
    <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><ListTodo size={20} aria-hidden="true" />{t.jobs}</h2>
      <button type="button" onClick={onClose} aria-label={t.close} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sepia-400"><X size={20} aria-hidden="true" /></button>
    </div>
    <div className="space-y-4 p-5">
      <section aria-label={t.backgroundRecognition} className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/50 p-4 text-xs">
        <h3 className="text-sm font-semibold text-white">{t.backgroundRecognition}</h3>
        {recognition.total === 0 && !waitingForArchive ? <p className="text-slate-400">{t.noPhotos}</p> : <>
          <p role="status">{faceStatus} · {recognition.completed}/{recognition.total}</p>
          <progress aria-label={t.recognitionArchiveProgress} max={Math.max(1, recognition.total)} value={recognition.completed} className="block h-2 w-full accent-amber-600" />
          <p className="text-slate-400">{t.recognitionScanHelp}</p>
          {recognition.failed > 0 && <p className="text-amber-200">{t.recognitionFailedPhotos} {recognition.failed}</p>}
          {recognition.error && <p role="alert" className="text-red-200">{t.recognitionFailed}</p>}
          {recognition.total > 0 && <div className="flex flex-wrap items-center gap-3">
            {recognition.failed > 0 && <button type="button" disabled={recognition.clearing || waitingForArchive} onClick={recognition.retry} className="text-amber-200 underline disabled:opacity-50">{t.retryRecognition}</button>}
            <button type="button" disabled={recognition.clearing || waitingForArchive} onClick={recognition.paused ? recognition.resume : recognition.pause} className="rounded-lg border border-slate-600 px-3 py-1.5 hover:bg-slate-700 disabled:opacity-50">{recognition.paused ? t.resumeRecognition : t.pauseRecognition}</button>
          </div>}
        </>}
      </section>
      <section aria-label={t.photoSimilarity} className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/50 p-4 text-xs">
        <h3 className="text-sm font-semibold text-white">{t.photoSimilarity}</h3>
        <p role="status">{indexingStatus} · {similarityIndexing.completed}/{similarityIndexing.total}</p>
        <progress aria-label={t.similarityProgress} max={Math.max(1, similarityIndexing.total)} value={similarityIndexing.completed} className="block h-2 w-full accent-amber-600" />
        {similarityIndexing.currentFileName && <p className="break-all text-slate-400">{similarityIndexing.currentFileName}</p>}
        <p className="text-slate-400">{t.similarityScanHelp}</p>
        {similarityIndexing.failed > 0 && <p className="text-amber-200">{t.recognitionFailedPhotos} {similarityIndexing.failed}</p>}
        {similarityIndexing.error && <p role="alert" className="text-amber-200">{t.similarityScanFailed}</p>}
        {similarityIndexing.total > 0 && <div className="flex flex-wrap items-center gap-3">
          {similarityIndexing.failed > 0 && <button type="button" disabled={waitingForArchive} onClick={similarityIndexing.retry} className="text-amber-200 underline disabled:opacity-50">{t.retryRecognition}</button>}
          <button type="button" disabled={waitingForArchive} onClick={similarityIndexing.paused ? similarityIndexing.resume : similarityIndexing.pause} className="rounded-lg border border-slate-600 px-3 py-1.5 hover:bg-slate-700 disabled:opacity-50">{similarityIndexing.paused ? t.resumeSimilarity : t.pauseSimilarity}</button>
        </div>}
        {similarity && <div className="space-y-3 border-t border-slate-700 pt-3">
          <p className="break-all text-slate-400">{similarity.fileName}</p>
          <p role={similarity.status === 'failed' ? 'alert' : 'status'} className={similarity.status === 'failed' ? 'text-red-200' : 'text-slate-300'}>{similarityStatus}</p>
          {similarity.total > 0 && <>
            <p aria-live="polite">{suggestions.progress.replace('{done}', String(similarity.completed)).replace('{total}', String(similarity.total))}</p>
            <progress aria-label={t.similarityComparisonProgress} max={Math.max(1, similarity.total)} value={similarity.completed} className="block h-2 w-full accent-amber-600" />
          </>}
          {Boolean(similarity.skipped) && <p className="text-amber-200">{suggestions.skipped.replace('{count}', String(similarity.skipped))}</p>}
        </div>}
      </section>
    </div>
  </dialog>;
};
