import React, { useEffect, useId, useRef, useState } from 'react';
import { UserPlus } from 'lucide-react';
import type { Language } from '../types';
import { translations } from '../utils/translations';
import { canonicalPersonName, normalizePersonName, personNameKey } from '../utils/people';

interface PersonPickerProps {
  knownPeople: string[];
  excludedPeople?: string[];
  language: Language;
  onSelect: (name: string) => void;
  label?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  direction?: 'up' | 'down';
}

export const PersonPicker: React.FC<PersonPickerProps> = ({ knownPeople, excludedPeople = [], language, onSelect, label, submitLabel, autoFocus = false, direction = 'down' }) => {
  const t = translations[language];
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const name = normalizePersonName(query);
  const key = personNameKey(name);
  const alreadySelected = Boolean(name) && excludedPeople.some(person => personNameKey(person) === key);
  const existing = knownPeople.filter(person => !excludedPeople.some(excluded => personNameKey(excluded) === personNameKey(person)) && personNameKey(person).includes(key));
  const options = existing.map(person => ({ name: person, create: false }));
  if (name && !alreadySelected && !knownPeople.some(person => personNameKey(person) === key)) options.push({ name, create: true });
  const highlightedIndex = Math.min(activeIndex, options.length - 1);

  useEffect(() => { if (autoFocus) { input.current?.focus(); setOpen(true); } }, [autoFocus]);

  const choose = (value: string) => {
    const selected = canonicalPersonName(value, knownPeople);
    if (!selected || excludedPeople.some(person => personNameKey(person) === personNameKey(selected))) return;
    onSelect(selected);
    setQuery('');
    setOpen(false);
    setActiveIndex(0);
  };

  return (
    <form
      className="relative min-w-0"
      onSubmit={event => {
        event.preventDefault(); event.stopPropagation();
        if (name && !alreadySelected) choose(name);
        else { input.current?.focus(); setOpen(true); }
      }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
      onClick={event => event.stopPropagation()}
    >
      <div className="flex gap-2 min-w-0">
        <input
          ref={input}
          role="combobox"
          aria-label={label || t.personName}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && highlightedIndex >= 0 ? `${listId}-${highlightedIndex}` : undefined}
          type="text"
          autoComplete="off"
          value={query}
          placeholder={t.choosePersonPlaceholder}
          onFocus={() => setOpen(true)}
          onChange={event => { setQuery(event.target.value); setOpen(true); setActiveIndex(0); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); setOpen(true);
              setActiveIndex(index => Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
            } else if (event.key === 'Enter' && open && highlightedIndex >= 0) {
              event.preventDefault(); event.stopPropagation(); choose(options[highlightedIndex].name);
            } else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
          }}
          className="min-w-0 flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:ring-2 focus:ring-sepia-500 focus:outline-none"
        />
        <button type="submit" title={name ? (submitLabel || t.addPerson) : t.choosePersonHint} className="shrink-0 flex items-center justify-center gap-1.5 bg-sepia-700 hover:bg-sepia-600 px-3 py-2 rounded-lg text-sm text-white">
          <UserPlus aria-hidden="true" size={16} />
          {submitLabel || t.addPerson}
        </button>
      </div>
      {alreadySelected && <p role="status" className="mt-1 text-xs text-slate-400">{t.personAlreadyAdded}</p>}
      {open && (
        <div className={`absolute inset-x-0 z-50 rounded-lg border border-slate-600 bg-slate-900 shadow-xl ${direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-1'}`}>
          <ul id={listId} role="listbox" aria-label={t.archivePeople} className="max-h-44 overflow-y-auto py-1">
            {options.map((option, index) => (
              <li
                id={`${listId}-${index}`} key={personNameKey(option.name)} role="option" aria-selected={index === highlightedIndex}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option.name)}
                className={`cursor-pointer px-3 py-2 text-sm break-words ${index === highlightedIndex ? 'bg-slate-700 text-white' : 'text-slate-200 hover:bg-slate-800'}`}
              >{option.create ? `${t.createPerson}: ${option.name}` : option.name}</li>
            ))}
          </ul>
          {options.length === 0 && <p className="px-3 pb-3 pt-1 text-xs text-slate-400">{knownPeople.length ? t.allPeopleAdded : t.noArchivePeople}</p>}
        </div>
      )}
    </form>
  );
};
