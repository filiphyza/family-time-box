import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { Pencil, Save, Trash2, Info, X } from 'lucide-react';
import type { FamilyTreePerson, Language } from '../types';
import { getPersonLocations, type FamilyTreePersonDetails } from '../utils/familyTree';
import { partialDateDraft, serializePartialDate, formatPartialDate, type PartialDateDraft, type DatePrecision } from '../utils/partialDates';
import { getPersonNameParts, type MaidenNameInfo } from '../utils/people';
import { translations } from '../utils/translations';

const personError = (error: unknown, language: Language) => {
  const t = translations[language];
  const code = (error as { code?: keyof typeof t.treeErrors })?.code;
  return code && t.treeErrors[code] || t.treeSaveFailed;
};

interface EditorProps { person: FamilyTreePerson; maidenNameInfo: MaidenNameInfo; language: Language; disabled: boolean; onSave: (details: FamilyTreePersonDetails) => Promise<void> }
export const PersonDetailsEditor: React.FC<EditorProps> = ({ person, maidenNameInfo, language, disabled, onSave }) => {
  const t = translations[language];
  const descriptionHelpId = useId();
  const descriptionPrivacyId = useId();
  const descriptionPrivacyNotice = <p id={descriptionPrivacyId} className="ft-description-name-privacy" role="note"><Info size={16} aria-hidden="true" /><span><strong>{t.treeDescriptionNamePrivacyTitle}.</strong> {t.treeDescriptionNamePrivacy}</span></p>;
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState(() => getPersonNameParts(person).firstName);
  const [lastName, setLastName] = useState(() => getPersonNameParts(person).lastName);
  const [maidenName, setMaidenName] = useState(person.maidenName || '');
  const [descriptionName, setDescriptionName] = useState(person.descriptionName || '');
  const savedLocations = getPersonLocations(person);
  const [locations, setLocations] = useState(() => savedLocations.length ? savedLocations : ['']);
  const [inheritMaidenName, setInheritMaidenName] = useState(person.maidenName === undefined);
  const [relationshipGender, setRelationshipGender] = useState<FamilyTreePerson['relationshipGender'] | ''>(person.relationshipGender || '');
  const [birth, setBirth] = useState(() => partialDateDraft(person.birthDate));
  const [death, setDeath] = useState(() => partialDateDraft(person.deathDate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (editing) nameInput.current?.focus({ preventScroll: true });
    else if (wasEditing.current) editButton.current?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);
  const open = () => {
    setRelationshipGender(person.relationshipGender || '');
    const parts = getPersonNameParts(person);
    setFirstName(parts.firstName); setLastName(parts.lastName);
    setDescriptionName(person.descriptionName || '');
    setLocations(savedLocations.length ? savedLocations : ['']);
    setMaidenName(person.maidenName || ''); setInheritMaidenName(person.maidenName === undefined);
    setBirth(partialDateDraft(person.birthDate)); setDeath(partialDateDraft(person.deathDate)); setError(null); setEditing(true);
  };
  if (!editing) return <div className="ft-person-edit-section">
    {(person.birthDate || person.deathDate || person.descriptionName || savedLocations.length > 0) && <dl className="ft-life-dates">
      {person.descriptionName && <div><dt>{t.treeDescriptionName}</dt><dd>{person.descriptionName}</dd></div>}
      {savedLocations.length > 0 && <div><dt>{t.treeLocations}</dt><dd><ul className="ft-location-list">{savedLocations.map(location => <li key={location}>{location}</li>)}</ul></dd></div>}
      {person.birthDate && <div><dt>{t.treeBirthDate}</dt><dd>{formatPartialDate(person.birthDate, language)}</dd></div>}
      {person.deathDate && <div><dt>{t.treeDeathDate}</dt><dd>{formatPartialDate(person.deathDate, language)}</dd></div>}
    </dl>}
    {person.descriptionName && descriptionPrivacyNotice}
    <button ref={editButton} type="button" className="ft-action" onClick={open} disabled={disabled}><Pencil size={15} />{t.treeEditPerson}</button>
  </div>;

  return <form className="ft-person-form" aria-label={t.treeEditPerson} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!lock.current) setEditing(false); }
  }} onSubmit={async event => {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true; setSaving(true); setError(null);
    try {
      await onSave({ firstName, lastName, descriptionName, locations, maidenName: inheritMaidenName ? undefined : maidenName, relationshipGender: relationshipGender || undefined, birthDate: serializePartialDate(birth), deathDate: serializePartialDate(death) });
      setEditing(false);
    } catch (cause) { setError(personError(cause, language)); }
    finally { lock.current = false; setSaving(false); }
  }}>
    <fieldset disabled={saving || disabled}>
      <div className="ft-name-fields">
        <label className="ft-edit-label">{t.treeFirstName}<input ref={nameInput} type="text" required value={firstName} onChange={event => setFirstName(event.target.value)} autoComplete="given-name" /></label>
        <label className="ft-edit-label">{t.treeLastName}<input type="text" value={lastName} onChange={event => setLastName(event.target.value)} autoComplete="family-name" /></label>
      </div>
      <p className="ft-edit-help">{t.treeNameSync}</p>
      <label className="ft-edit-label ft-description-name-field">{t.treeDescriptionName}
        <input type="text" aria-describedby={`${descriptionHelpId} ${descriptionPrivacyId}`} value={descriptionName} placeholder={person.name} onChange={event => setDescriptionName(event.target.value)} autoComplete="off" />
      </label>
      <p id={descriptionHelpId} className="ft-edit-help">{t.treeDescriptionNameHelp}</p>
      {descriptionPrivacyNotice}
      <label className="ft-edit-label ft-maiden-field">{t.treeMaidenName}
        <input type="text" value={inheritMaidenName ? maidenNameInfo.inheritedValue : maidenName} onChange={event => { setMaidenName(event.target.value); setInheritMaidenName(false); }} autoComplete="off" />
      </label>
      {inheritMaidenName ? <p className="ft-edit-help">{maidenNameInfo.fatherName && maidenNameInfo.inheritedValue ? t.treeMaidenFromFather.replace('{name}', maidenNameInfo.fatherName) : t.treeMaidenInherited}</p>
        : <button type="button" className="ft-inherit-maiden" onClick={() => setInheritMaidenName(true)}>{t.treeMaidenUseFather}</button>}

      <label className="ft-edit-label ft-person-title-field">{t.treeRelationshipTitles}
        <select value={relationshipGender} onChange={event => setRelationshipGender(event.target.value as FamilyTreePerson['relationshipGender'] | '')}>
          <option value="">{t.treeTitlesNeutral}</option><option value="male">{t.treeTitlesMale}</option><option value="female">{t.treeTitlesFemale}</option>
        </select>
      </label>
      <fieldset className="ft-locations">
        <legend>{t.treeLocations} <span>({t.treeOptional})</span></legend>
        {locations.map((location, index) => <div className="ft-location-row" key={index}>
          <label className="ft-edit-label">{t.treeLocation} {index + 1}
            <input type="text" value={location} onChange={event => setLocations(current => current.map((value, item) => item === index ? event.target.value : value))} autoComplete="off" />
          </label>
          <button type="button" className="ft-action ft-location-remove" aria-label={`${t.treeRemoveLocation} ${index + 1}`} onClick={() => setLocations(current => current.filter((_, item) => item !== index))}><X size={16} aria-hidden="true" /></button>
        </div>)}
        <button type="button" className="ft-action" onClick={() => setLocations(current => [...current, ''])}>{t.treeAddLocation}</button>
      </fieldset>
      <PartialDateField label={t.treeBirthDate} value={birth} onChange={setBirth} language={language} />
      <PartialDateField label={t.treeDeathDate} value={death} onChange={setDeath} language={language} />
    </fieldset>
    {error && <p role="alert" className="ft-error">{error}</p>}
    {saving && <p role="status" className="ft-edit-help">{t.treePersonSaving}</p>}
    <div className="ft-edit-buttons">
      <button type="submit" className="ft-action ft-action-primary" disabled={saving || disabled}><Save size={15} />{t.treeSavePerson}</button>
      <button type="button" className="ft-cancel" disabled={saving || disabled} onClick={() => setEditing(false)}>{t.treeCancel}</button>
    </div>
  </form>;
};

const PartialDateField: React.FC<{ label: string; value: PartialDateDraft; onChange: (value: PartialDateDraft) => void; language: Language }> = ({ label, value, onChange, language }) => {
  const t = translations[language];
  const hasYear = ['year', 'month', 'date'].includes(value.precision);
  const hasMonth = ['month', 'date', 'monthOnly'].includes(value.precision);
  const hasDay = value.precision === 'date';
  const partCount = Number(hasYear) + Number(hasMonth) + Number(hasDay);
  return <fieldset className="ft-partial-date">
    <legend>{label} <span>({t.treeOptional})</span></legend>
    <label className="ft-edit-label">{t.treeDatePrecision}
      <select aria-label={`${label} ${language === 'sk' ? 'presnosť' : 'precision'}`} value={value.precision} onChange={event => onChange({ ...value, precision: event.target.value as DatePrecision })}>
        <option value="none">{t.treeDateUnknown}</option><option value="year">{t.treeDateYear}</option><option value="month">{t.treeDateMonth}</option><option value="date">{t.treeDateFull}</option><option value="monthOnly">{t.treeDateMonthOnly}</option>
      </select>
    </label>
    {partCount > 0 && <div className="ft-date-parts" style={{ gridTemplateColumns: `repeat(${partCount}, minmax(0, 1fr))` }}>
      {hasYear && <label className="ft-edit-label">{t.treeYear}<input type="number" aria-label={`${label} ${t.treeYear.toLowerCase()}`} min="1" max="9999" step="1" required value={value.year} onChange={event => onChange({ ...value, year: event.target.value })} inputMode="numeric" /></label>}
      {hasMonth && <label className="ft-edit-label">{t.treeMonth}<select aria-label={`${label} ${t.treeMonth.toLowerCase()}`} required value={value.month} onChange={event => onChange({ ...value, month: event.target.value })}>
        <option value="">—</option>{Array.from({ length: 12 }, (_, month) => <option key={month} value={String(month + 1)}>{new Intl.DateTimeFormat(language === 'sk' ? 'sk' : 'en', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month, 1)))}</option>)}
      </select></label>}
      {hasDay && <label className="ft-edit-label">{t.treeDay}<input type="number" aria-label={`${label} ${t.treeDay.toLowerCase()}`} min="1" max="31" step="1" required value={value.day} onChange={event => onChange({ ...value, day: event.target.value })} inputMode="numeric" /></label>}
    </div>}
  </fieldset>;
};

interface DeleteProps { person: FamilyTreePerson; language: Language; disabled: boolean; canDelete: boolean; resetsRoot: boolean; onDelete: () => Promise<void> }
export const DeleteFamilyMember: React.FC<DeleteProps> = ({ person, language, disabled, canDelete, resetsRoot, onDelete }) => {
  const t = translations[language];
  const [confirming, setConfirming] = useState(false);
  return <div className="ft-person-delete-section">
    <button type="button" className="ft-action ft-action-danger" disabled={disabled || !canDelete} title={!canDelete ? t.treeDeleteHasChildren : t.treeDeletePerson} onClick={() => setConfirming(true)}><Trash2 size={15} />{t.treeDeletePerson}</button>
    {!canDelete && <p className="ft-edit-help">{t.treeDeleteHasChildren}</p>}
    {confirming && <DeleteConfirmation person={person} language={language} resetsRoot={resetsRoot} onDelete={onDelete} onClose={() => setConfirming(false)} />}
  </div>;
};

const DeleteConfirmation: React.FC<Omit<DeleteProps, 'disabled' | 'canDelete'> & { onClose: () => void }> = ({ person, language, resetsRoot, onDelete, onClose }) => {
  const t = translations[language];
  const dialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    const element = dialog.current;
    return () => { if (element?.open) element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="ft-dialog ft-delete-dialog" aria-labelledby="tree-delete-title" aria-describedby="tree-delete-description" onCancel={event => { event.preventDefault(); if (!lock.current) onClose(); }}>
    <div className="ft-dialog-header"><h2 id="tree-delete-title">{t.treeDeletePerson}</h2><button type="button" aria-label={t.close} disabled={saving} onClick={onClose}><X size={20} /></button></div>
    <p id="tree-delete-description">{t.treeDeletePersonConfirm.replace('{name}', person.name)}</p>
    {resetsRoot && <p>{t.treeDeleteRootHint}</p>}
    {error && <p role="alert" className="ft-error">{error}</p>}
    {saving && <p role="status">{t.treePersonDeleting}</p>}
    <div className="ft-edit-buttons">
      <button type="button" className="ft-cancel" disabled={saving} autoFocus onClick={onClose}>{t.treeCancel}</button>
      <button type="button" className="ft-action ft-action-danger" disabled={saving} onClick={async () => {
        if (lock.current) return;
        lock.current = true; setSaving(true); setError(null);
        try { await onDelete(); onClose(); }
        catch (cause) { setError(personError(cause, language)); }
        finally { lock.current = false; setSaving(false); }
      }}><Trash2 size={15} />{t.treeDeletePerson}</button>
    </div>
  </dialog>;
};
