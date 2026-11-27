import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Calendar, MapPin, RefreshCw, Sparkles } from 'lucide-react';
import type { Language, Photo } from '../types';
import { findSimilarPhotos } from '../services/photoSimilarity';
import { comparePhotoScenes, matchIndexedPhotoScenes, similaritySourceRevision, validSimilarityIndex } from '../services/sceneEmbedding';
import { buildMetadataSuggestions, type MetadataSuggestion, type SimilarPhotoMatch } from '../utils/photoSuggestions';
import { formatPartialDate, isPartialDate } from '../utils/partialDates';
import { confirmedMetadataReferences } from '../utils/automaticPhotoSuggestions';
import { photoSuggestionTranslations } from '../utils/photoSuggestionTranslations';
import type { PhotoSimilarityJob } from './JobsPopup';

type Field = 'dateOfPhoto' | 'location';
interface PhotoMetadataSuggestionsProps {
  photo: Photo;
  archivePhotos: Photo[];
  language: Language;
  disabled?: boolean;
  getCurrentPhoto: (id: string) => Photo | undefined;
  onApply: (field: Field, value: string) => void;
  onJobChange: (job: PhotoSimilarityJob | null) => void;
}
interface ComparisonState {
  identity: string;
  matches: SimilarPhotoMatch[];
  rankedPhotoIds: string[];
  compared: number;
  skipped: number;
  method: 'visual' | 'ai';
  baseline: { dateOfPhoto: string; location: string };
}
const hasDate = (photo: Photo) => isPartialDate(photo.dateOfPhoto) && !photo.dateOfPhoto.startsWith('--');
const sourcePreview = (photo: Photo) => photo.thumbnailSource === 'original' && photo.thumbnailUrl || photo.originalUrl;
const fieldValue = (photo: Photo, field: Field) => photo[field] || '';
const locationKey = (value?: string) => (value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export const PhotoMetadataSuggestions: React.FC<PhotoMetadataSuggestionsProps> = ({ photo, archivePhotos, language, disabled = false, getCurrentPhoto, onApply, onJobChange }) => {
  const t = photoSuggestionTranslations[language];
  const titleId = useId();
  const references = confirmedMetadataReferences(archivePhotos).filter(item => item.id !== photo.id && (hasDate(item) || item.location?.trim()));
  // Compare source identities without duplicating potentially large data URLs in
  // serialized dependency keys. Face-index and thumbnail updates do not restart.
  const inputs = useRef<{ id: string; source: string; originalRevision?: string; references: Photo[]; revision: number } | null>(null);
  const previous = inputs.current;
  if (!previous || previous.id !== photo.id || previous.source !== photo.originalUrl || previous.originalRevision !== similaritySourceRevision(photo) || previous.references.length !== references.length ||
    references.some((item, index) => {
      const before = previous.references[index];
      return before.id !== item.id || before.originalUrl !== item.originalUrl || similaritySourceRevision(before) !== similaritySourceRevision(item) || before.fileName !== item.fileName || before.dateOfPhoto !== item.dateOfPhoto || before.location !== item.location;
    })) inputs.current = { id: photo.id, source: photo.originalUrl, originalRevision: similaritySourceRevision(photo), references, revision: (previous?.revision || 0) + 1 };
  const identity = String(inputs.current.revision);
  const indexedReferences = references.filter(validSimilarityIndex);
  const canUseIndex = validSimilarityIndex(photo) && indexedReferences.length > 0;
  const indexedInputs = useRef<{ target: Photo['similarityIndex']; references: Photo['similarityIndex'][]; revision: number } | null>(null);
  if (!indexedInputs.current || indexedInputs.current.target !== photo.similarityIndex || indexedInputs.current.references.length !== indexedReferences.length ||
    indexedReferences.some((item, index) => item.similarityIndex !== indexedInputs.current!.references[index])) {
    indexedInputs.current = { target: photo.similarityIndex, references: indexedReferences.map(item => item.similarityIndex), revision: (indexedInputs.current?.revision || 0) + 1 };
  }
  const indexRevision = canUseIndex ? indexedInputs.current.revision : 0;
  const latest = useRef({ photo, references, getCurrentPhoto });
  latest.current = { photo, references, getCurrentPhoto };
  const [comparison, setComparison] = useState<ComparisonState | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [retry, setRetry] = useState(0);
  const [localError, setLocalError] = useState(false);
  const [aiError, setAiError] = useState<unknown>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [applyError, setApplyError] = useState<'detailsChanged' | 'sourceChanged' | null>(null);
  const aiController = useRef<AbortController | null>(null);
  const visualController = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    visualController.current = controller;
    aiController.current?.abort();
    setAiLoading(false); setAiError(null); setApplyError(null); setLocalError(false); setCancelled(false);
    setComparison(null);
    const snapshot = latest.current;
    const baseline = comparison?.identity === identity ? comparison.baseline : { dateOfPhoto: snapshot.photo.dateOfPhoto || '', location: snapshot.photo.location || '' };
    if (canUseIndex) {
      const indexed = snapshot.references.filter(validSimilarityIndex);
      setProgress({ done: indexed.length, total: indexed.length });
      setLoading(false);
      setComparison({ identity, matches: matchIndexedPhotoScenes(snapshot.photo, indexed) || [], rankedPhotoIds: indexed.map(item => item.id),
        compared: indexed.length, skipped: 0, method: 'ai', baseline });
      return () => { controller.abort(); aiController.current?.abort(); };
    }
    setProgress({ done: 0, total: snapshot.references.length });
    setLoading(snapshot.references.length > 0);
    if (snapshot.references.length) {
      void findSimilarPhotos(snapshot.photo, snapshot.references, { signal: controller.signal, onProgress: (done, total) => {
        if (!controller.signal.aborted) setProgress({ done, total });
      } }).then(result => {
        if (controller.signal.aborted || currentGeneration !== generation.current) return;
        if (validSimilarityIndex(latest.current.photo) && latest.current.references.some(validSimilarityIndex)) return;
        setComparison({ identity, ...result, method: 'visual', baseline });
      }).catch(error => {
        if (!controller.signal.aborted && currentGeneration === generation.current) {
          console.warn('Archive photo comparison failed.', error);
          setLocalError(true);
        }
      }).finally(() => {
        if (!controller.signal.aborted && currentGeneration === generation.current) setLoading(false);
      });
    }
    return () => { controller.abort(); aiController.current?.abort(); };
  }, [identity, retry]);

  // Catalogue updates refresh suggestions without cancelling a comparison the
  // user explicitly requested. Keep fuller manual results while indexing catches up.
  useEffect(() => {
    if (!canUseIndex || aiLoading) return;
    const snapshot = latest.current;
    const indexed = snapshot.references.filter(validSimilarityIndex);
    if (comparison?.identity === identity && comparison.method === 'ai' && comparison.compared > indexed.length) return;
    visualController.current?.abort();
    setLoading(false);
    setLocalError(false);
    setAiError(null);
    setCancelled(false);
    setProgress({ done: indexed.length, total: indexed.length });
    setComparison({ identity, matches: matchIndexedPhotoScenes(snapshot.photo, indexed) || [], rankedPhotoIds: indexed.map(item => item.id),
      compared: indexed.length, skipped: 0, method: 'ai',
      baseline: comparison?.identity === identity ? comparison.baseline : { dateOfPhoto: snapshot.photo.dateOfPhoto || '', location: snapshot.photo.location || '' } });
  }, [identity, indexRevision, aiLoading]);

  const currentComparison = comparison?.identity === identity ? comparison : null;
  useEffect(() => {
    onJobChange({
      fileName: photo.fileName,
      status: loading || aiLoading ? 'running' : localError || aiError ? 'failed' : cancelled ? 'cancelled'
        : currentComparison ? 'complete' : references.length ? 'waiting' : 'idle',
      method: aiLoading || aiError || cancelled ? 'ai' : currentComparison?.method || 'visual',
      completed: progress.done,
      total: progress.total,
      skipped: currentComparison?.skipped || 0,
    });
  }, [photo.fileName, loading, aiLoading, localError, aiError, cancelled, currentComparison, references.length, progress, onJobChange]);
  useEffect(() => () => onJobChange(null), [onJobChange]);
  const suggestions = useMemo(() => currentComparison
    ? buildMetadataSuggestions(photo, references, currentComparison.matches, currentComparison.method, { compared: currentComparison.compared, skipped: currentComparison.skipped })
    : null, [currentComparison, photo, archivePhotos]);
  const hasSuggestions = Boolean(suggestions?.dates.length || suggestions?.locations.length);
  const currentDetailsSupported = currentComparison?.matches.some(match => {
    const source = references.find(item => item.id === match.photoId);
    return source && (match.dateEvidence && hasDate(photo) && source.dateOfPhoto === photo.dateOfPhoto ||
      match.locationEvidence && photo.location?.trim() && locationKey(source.location) === locationKey(photo.location));
  });

  const compareWithAi = async () => {
    if (disabled || loading || aiLoading || !references.length) return;
    aiController.current?.abort();
    const controller = new AbortController();
    aiController.current = controller;
    const currentGeneration = generation.current;
    const snapshot = latest.current;
    const baseline = { dateOfPhoto: snapshot.photo.dateOfPhoto || '', location: snapshot.photo.location || '' };
    // Local scene embeddings can compare every reference, including photos whose
    // objects match despite different framing or colors in the fast visual scan.
    const selected = snapshot.references;
    setProgress({ done: 0, total: selected.length });
    setAiLoading(true); setAiError(null); setLocalError(false); setApplyError(null); setCancelled(false);
    try {
      const matches = await comparePhotoScenes(snapshot.photo, selected, language, { signal: controller.signal, onProgress: (done, total) => {
        if (!controller.signal.aborted && currentGeneration === generation.current) setProgress({ done, total });
      } });
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      const current = latest.current.getCurrentPhoto(snapshot.photo.id);
      if (!current || current.originalUrl !== snapshot.photo.originalUrl) return;
      setProgress({ done: selected.length, total: selected.length });
      setComparison({ identity, matches, rankedPhotoIds: selected.map(item => item.id), compared: selected.length, skipped: currentComparison?.skipped || 0, method: 'ai', baseline });
    } catch (error) {
      if (!controller.signal.aborted && currentGeneration === generation.current) setAiError(error);
    } finally {
      if (!controller.signal.aborted && currentGeneration === generation.current) setAiLoading(false);
    }
  };

  const apply = (field: Field, suggestion: MetadataSuggestion) => {
    if (disabled || !currentComparison || aiLoading || loading) return;
    const current = getCurrentPhoto(photo.id);
    if (!current || current.originalUrl !== photo.originalUrl) return;
    if (fieldValue(current, field) !== currentComparison.baseline[field]) { setApplyError('detailsChanged'); return; }
    const validSources = suggestion.sourcePhotoIds.some(id => {
      const before = references.find(item => item.id === id);
      const now = getCurrentPhoto(id);
      return before && now && now.originalUrl === before.originalUrl && (field === 'location'
        ? locationKey(now.location) === locationKey(suggestion.value)
        : fieldValue(now, field) === suggestion.value);
    });
    if (!validSources) { setApplyError('sourceChanged'); return; }
    setApplyError(null);
    setComparison(value => value?.identity === identity ? { ...value, baseline: { ...value.baseline, [field]: suggestion.value } } : value);
    onApply(field, suggestion.value);
  };

  const renderSuggestion = (field: Field, suggestion: MetadataSuggestion, index: number) => {
    const isDate = field === 'dateOfPhoto';
    const value = isDate ? formatPartialDate(suggestion.value, language) : suggestion.value;
    const action = isDate ? photo.dateOfPhoto ? t.replaceDate : t.useDate : photo.location?.trim() ? t.replacePlace : t.usePlace;
    const sources = suggestion.sourcePhotoIds.map(id => archivePhotos.find(item => item.id === id)).filter((item): item is Photo => Boolean(item));
    return <article key={`${field}:${suggestion.value}`} className="min-w-0 space-y-2 rounded-lg border border-slate-700 bg-slate-950/50 p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><p className="break-words text-sm font-semibold text-sepia-100">{value}</p><p className="mt-0.5 text-xs text-slate-400">{suggestion.confidence === 'strong' ? t.strong : t.possible}</p></div>
        <button type="button" disabled={disabled || loading || aiLoading} onClick={() => apply(field, suggestion)} aria-label={`${action}: ${value}`} className="shrink-0 rounded-md bg-sepia-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sepia-600 disabled:opacity-50">{action}</button>
      </div>
      <p className="text-xs text-slate-300">{suggestion.reasons.map(reason => t.reasons[reason]).filter(Boolean).join(' · ')}</p>
      <details className="text-xs" open={index === 0}>
        <summary className="cursor-pointer text-slate-400 hover:text-slate-200">{t.basedOn.replace('{count}', String(sources.length))}</summary>
        <div className="mt-2 space-y-2">{sources.slice(0, 3).map(source => <div key={source.id} className="flex min-w-0 items-center gap-2">
          <img src={sourcePreview(source)} alt={`${t.referencePhoto}: ${source.fileName}`} loading="lazy" decoding="async" className="h-14 w-16 shrink-0 rounded bg-slate-800 object-contain" />
          <div className="min-w-0 space-y-0.5 text-slate-400"><p className="break-all text-slate-300">{source.fileName}</p>{hasDate(source) && <p>{formatPartialDate(source.dateOfPhoto, language)}</p>}{source.location?.trim() && <p className="break-words">{source.location}</p>}</div>
        </div>)}</div>
      </details>
    </article>;
  };

  return <section aria-labelledby={titleId} aria-busy={loading || aiLoading} className="space-y-3 rounded-xl border border-sepia-800/70 bg-sepia-950/20 p-3">
    <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-sepia-100"><Sparkles size={16} aria-hidden="true" />{t.title}</h3>
    <p className="text-xs leading-relaxed text-slate-300">{t.help}</p>
    {!references.length ? <p role="status" className="text-xs text-slate-400">{t.noReferences}</p> : <>
      {!loading && !localError && currentComparison && !hasSuggestions && <p role="status" className="text-xs text-slate-400">{currentDetailsSupported ? t.noAlternatives : currentComparison.method === 'ai' ? t.noAiMatches : t.noMatches}</p>}
      {hasSuggestions && <div className="space-y-3">
        {Boolean(suggestions.dates.length) && <div className="space-y-2"><h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-300"><Calendar size={13} aria-hidden="true" />{t.date}</h4>{suggestions.dates.map((item, index) => renderSuggestion('dateOfPhoto', item, index))}</div>}
        {Boolean(suggestions.locations.length) && <div className="space-y-2"><h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-300"><MapPin size={13} aria-hidden="true" />{t.place}</h4>{suggestions.locations.map((item, index) => renderSuggestion('location', item, index))}</div>}
      </div>}
      {applyError && <p role="alert" className="text-xs text-amber-200">{t[applyError]}</p>}
      <div className="space-y-2 border-t border-slate-700/70 pt-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={disabled || loading || aiLoading} onClick={() => { setComparison(null); setRetry(value => value + 1); }} className="flex items-center gap-1.5 rounded-md border border-slate-600 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"><RefreshCw size={13} aria-hidden="true" />{t.refresh}</button>
          <button type="button" disabled={disabled || loading || aiLoading} onClick={() => { void compareWithAi(); }} className="flex items-center gap-1.5 rounded-md border border-sepia-700 bg-sepia-900/40 px-2.5 py-1.5 text-xs text-sepia-100 hover:bg-sepia-800/50 disabled:opacity-50"><Sparkles size={13} aria-hidden="true" />{t.compareAi}</button>
          {aiLoading && <button type="button" onClick={() => { aiController.current?.abort(); setAiLoading(false); setCancelled(true); }} className="rounded-md px-2.5 py-1.5 text-xs text-slate-300 underline hover:text-white">{t.cancel}</button>}
        </div>
        <p className="text-xs leading-relaxed text-slate-400">{t.aiHelp.replace('{count}', String(references.length))}</p>
      </div>
    </>}
  </section>;
};
