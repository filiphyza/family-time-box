import React, { useLayoutEffect, useRef, useState } from 'react';
import { Check, Image as ImageIcon, X } from 'lucide-react';
import type { AvatarCrop, FamilyTreePerson, Language, Photo } from '../types';
import { personNameKey } from '../utils/people';
import { displaySource, hasThumbnail } from '../utils/thumbnails';
import { translations } from '../utils/translations';

const initials = (name: string) => name.split(' ').map(word => word[0]).slice(0, 2).join('').toLocaleUpperCase();

function usePhotoSource(photo?: Photo, fullSize = false) {
  const [failed, setFailed] = useState<string[]>([]);
  const source = photo && (fullSize ? [displaySource(photo), hasThumbnail(photo) ? photo.thumbnailUrl : undefined] : [hasThumbnail(photo) ? photo.thumbnailUrl : undefined, displaySource(photo)]).find(value => value && !failed.includes(value));
  return { source, onError: () => { if (source) setFailed(current => [...current, source]); } };
}

const defaultCrop = (person: Pick<FamilyTreePerson, 'name'>, photo: Photo): AvatarCrop => {
  const face = photo.faceTags?.find(tag => personNameKey(tag.name) === personNameKey(person.name) && Number.isFinite(tag.x) && Number.isFinite(tag.y));
  return { x: face?.x ?? 50, y: face?.y ?? 50, zoom: face ? 2.5 : 1 };
};
const cropStyle = (crop: AvatarCrop, width: number, height: number): React.CSSProperties => {
  const side = Math.min(width, height) / crop.zoom;
  const left = Math.max(0, Math.min(width - side, width * crop.x / 100 - side / 2));
  const top = Math.max(0, Math.min(height - side, height * crop.y / 100 - side / 2));
  return { position: 'absolute', width: `${width / side * 100}%`, height: `${height / side * 100}%`, maxWidth: 'none', left: `${-left / side * 100}%`, top: `${-top / side * 100}%` };
};

/** Render a live archive reference, falling back gracefully if a photo is gone. */
export const PersonAvatar: React.FC<{ person: Pick<FamilyTreePerson, 'name' | 'avatarPhotoId' | 'avatarCrop'>; photo?: Photo; crop?: AvatarCrop }> = ({ person, photo, crop }) => {
  const framing = crop || (photo?.id === person.avatarPhotoId ? person.avatarCrop : undefined);
  const { source, onError } = usePhotoSource(photo, Boolean(framing));
  const [imageSize, setImageSize] = useState<{ source: string; width: number; height: number } | null>(null);
  const style: React.CSSProperties = photo && imageSize?.source === source
    ? cropStyle(framing || defaultCrop(person, photo), imageSize.width, imageSize.height)
    : { width: '100%', height: '100%', objectFit: 'cover' };
  return <span className="ft-portrait" aria-hidden="true" data-photo-id={source ? photo?.id : undefined}>
    {source ? <img key={source} src={source} alt="" draggable={false} decoding="async" onError={onError} style={style}
      onLoad={event => setImageSize({ source, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} /> : initials(person.name)}
  </span>;
};

interface PickerProps {
  person: FamilyTreePerson;
  photos: Photo[];
  language: Language;
  onSelect: (photoId: string | null, crop?: AvatarCrop) => Promise<void>;
  onClose: () => void;
}

export const PersonAvatarPicker: React.FC<PickerProps> = ({ person, photos, language, onSelect, onClose }) => {
  const t = translations[language];
  const dialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState<Photo | null>(null);
  const [crop, setCrop] = useState<AvatarCrop>({ x: 50, y: 50, zoom: 1 });
  const selectPhoto = (photo: Photo) => {
    setEditingPhoto(photo);
    setCrop(person.avatarPhotoId === photo.id && person.avatarCrop ? { ...person.avatarCrop } : defaultCrop(person, photo));
    setError(false);
  };
  useLayoutEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => {
      if (element?.open) element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const close = () => { if (!lock.current) onClose(); };
  const choose = async (photoId: string | null) => {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    setError(false);
    try { await onSelect(photoId, photoId ? crop : undefined); }
    catch { setError(true); }
    finally { lock.current = false; setSaving(false); }
  };

  return <dialog ref={dialog} className="ft-dialog ft-avatar-dialog" aria-labelledby="tree-avatar-title" aria-describedby="tree-avatar-description" aria-busy={saving} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="ft-avatar-dialog-heading">
      <div className="ft-dialog-header"><h2 id="tree-avatar-title">{t.treeChooseAvatar}</h2><button type="button" aria-label={t.close} onClick={close} disabled={saving}><X size={20} /></button></div>
      <p id="tree-avatar-description">{t.treeAvatarDescription.replace('{name}', person.name)}</p>
    </div>
    <div className="ft-avatar-options">
      {editingPhoto ? <div className="ft-avatar-crop-editor">
        <h3>{t.treeAvatarAdjust}</h3>
        <div className="ft-avatar-crop-preview"><PersonAvatar person={person} photo={editingPhoto} crop={crop} /></div>
        <p className="ft-edit-help">{t.treeAvatarCropHelp}</p>
        <fieldset disabled={saving}>
          <label>{t.treeAvatarZoom}<output>{crop.zoom.toFixed(1)}×</output><input aria-label={t.treeAvatarZoom} type="range" min="1" max="20" step="0.1" value={crop.zoom} onChange={event => setCrop(current => ({ ...current, zoom: Number(event.target.value) }))} /></label>
          <label>{t.treeAvatarHorizontal}<input aria-label={t.treeAvatarHorizontal} type="range" min="0" max="100" step="0.1" value={crop.x} onChange={event => setCrop(current => ({ ...current, x: Number(event.target.value) }))} /></label>
          <label>{t.treeAvatarVertical}<input aria-label={t.treeAvatarVertical} type="range" min="0" max="100" step="0.1" value={crop.y} onChange={event => setCrop(current => ({ ...current, y: Number(event.target.value) }))} /></label>
          <div className="ft-edit-buttons"><button type="button" className="ft-action" onClick={() => setCrop(defaultCrop(person, editingPhoto))}>{t.treeAvatarReset}</button><button type="button" className="ft-cancel" onClick={() => { setEditingPhoto(null); setError(false); }}>{t.treeAvatarBack}</button></div>
        </fieldset>
      </div> : photos.length ? <div className="ft-avatar-grid">
        {photos.map(photo => <PhotoChoice key={photo.id} photo={photo} person={person} language={language} disabled={saving} onChoose={() => selectPhoto(photo)} />)}
      </div> : <p className="ft-avatar-empty"><ImageIcon size={30} aria-hidden="true" />{t.treeAvatarEmpty}</p>}
    </div>
    <div className="ft-avatar-dialog-footer">
      {error && <p role="alert" className="ft-error">{t.treeSaveFailed}</p>}
      {saving && <p role="status">{t.treeAvatarSaving}</p>}
      <div className="ft-avatar-footer-buttons">
        <button type="button" className="ft-action" disabled={saving || !person.avatarPhotoId} onClick={() => choose(null)}>{t.treeAvatarInitials}</button>
        {editingPhoto && <button type="button" className="ft-action ft-action-primary" disabled={saving} onClick={() => choose(editingPhoto.id)}>{t.treeAvatarSave}</button>}
        <button type="button" className="ft-cancel" disabled={saving} onClick={close}>{t.treeCancel}</button>
      </div>
    </div>
  </dialog>;
};

const PhotoChoice: React.FC<{ photo: Photo; person: FamilyTreePerson; language: Language; disabled: boolean; onChoose: () => void }> = ({ photo, person, language, disabled, onChoose }) => {
  const t = translations[language];
  const { source, onError } = usePhotoSource(photo);
  const selected = person.avatarPhotoId === photo.id;
  return <button type="button" className={`ft-avatar-choice ${selected ? 'ft-avatar-choice-selected' : ''}`} aria-label={t.treeAvatarPhoto.replace('{fileName}', photo.fileName)} aria-pressed={selected} disabled={disabled || !source} onClick={onChoose}>
    <span className="ft-avatar-choice-photo">
      {source ? <img src={source} alt="" loading="lazy" decoding="async" onError={onError} /> : <ImageIcon size={32} aria-hidden="true" />}
      <span className="ft-avatar-choice-preview"><PersonAvatar person={person} photo={photo} /></span>
      {selected && <span className="ft-avatar-current" title={t.treeAvatarCurrent}><Check size={15} aria-hidden="true" /></span>}
    </span>
    <span className="ft-avatar-choice-name">{photo.fileName}</span>
  </button>;
};
