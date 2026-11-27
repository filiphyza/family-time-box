import React, { useEffect, useId, useRef, useState } from 'react';
import type { Language } from '../types';
import { isPartialDate, partialDateDraft, serializePartialDate, type DatePrecision, type PartialDateDraft } from '../utils/partialDates';
import { translations } from '../utils/translations';

interface PhotoDateFieldProps {
  value: string;
  language: Language;
  onChange: (value: string) => void;
}

export const PhotoDateField: React.FC<PhotoDateFieldProps> = ({ value, language, onChange }) => {
  const t = translations[language];
  const errorId = useId();
  const [draft, setDraft] = useState(() => partialDateDraft(value));
  const [invalid, setInvalid] = useState(false);
  const savedValue = useRef(value);
  useEffect(() => {
    // An autosave echo should preserve hidden fields when precision is reduced.
    // A change from outside this field still replaces its local draft.
    if (value === savedValue.current) return;
    savedValue.current = value;
    setDraft(partialDateDraft(value));
    setInvalid(false);
  }, [value]);
  const update = (next: PartialDateDraft) => {
    setDraft(next);
    const date = serializePartialDate(next) || '';
    const valid = !date || isPartialDate(date);
    setInvalid(!valid);
    // Keep incomplete edits in the field without replacing the last saved date.
    if (valid && date !== value) { savedValue.current = date; onChange(date); }
  };
  const hasYear = draft.precision !== 'none';
  const hasMonth = draft.precision === 'month' || draft.precision === 'date';
  const hasDay = draft.precision === 'date';
  const inputClass = 'w-full min-w-0 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:ring-2 focus:ring-sepia-500 focus:outline-none';
  const labelClass = 'block min-w-0 space-y-1 text-xs text-slate-400';
  const dateLabel = (part: string) => `${t.dateTaken} ${part.toLowerCase()}`;

  return <fieldset className="space-y-2" aria-describedby={invalid ? errorId : undefined}>
    <legend className="mb-2 text-xs uppercase tracking-wider text-slate-500 font-bold">{t.dateTaken}</legend>
    <label className={labelClass}>{t.treeDatePrecision}
      <select aria-label={dateLabel(t.treeDatePrecision)} value={draft.precision} className={inputClass}
        onChange={event => update({ ...draft, precision: event.target.value as DatePrecision })}>
        <option value="none">{t.treeDateUnknown}</option>
        <option value="year">{t.treeDateYear}</option>
        <option value="month">{t.treeDateMonth}</option>
        <option value="date">{t.treeDateFull}</option>
      </select>
    </label>
    {hasYear && <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${1 + Number(hasMonth) + Number(hasDay)}, minmax(0, 1fr))` }}>
      <label className={labelClass}>{t.treeYear}
        <input type="number" min="1" max="9999" step="1" inputMode="numeric" required aria-label={dateLabel(t.treeYear)} aria-invalid={invalid}
          className={inputClass} value={draft.year} onChange={event => update({ ...draft, year: event.target.value })} />
      </label>
      {hasMonth && <label className={labelClass}>{t.treeMonth}
        <select required aria-label={dateLabel(t.treeMonth)} aria-invalid={invalid} className={inputClass} value={draft.month}
          onChange={event => update({ ...draft, month: event.target.value })}>
          <option value="">—</option>
          {Array.from({ length: 12 }, (_, month) => <option key={month} value={String(month + 1)}>{new Intl.DateTimeFormat(language === 'sk' ? 'sk' : 'en', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month, 1)))}</option>)}
        </select>
      </label>}
      {hasDay && <label className={labelClass}>{t.treeDay}
        <input type="number" min="1" max="31" step="1" inputMode="numeric" required aria-label={dateLabel(t.treeDay)} aria-invalid={invalid}
          className={inputClass} value={draft.day} onChange={event => update({ ...draft, day: event.target.value })} />
      </label>}
    </div>}
    {invalid && <p id={errorId} role="alert" className="text-xs text-red-300">{t.treeErrors.invalidDate}</p>}
  </fieldset>;
};
