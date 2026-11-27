import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, Heart, Maximize, Minus, Plus, Target, UserRound, UserPlus, Camera, X } from 'lucide-react';
import type { AvatarCrop, FamilyTreeData, Language, Photo } from '../types';
import { addFamilyMember, updateFamilyMember, removeFamilyMember, canDeleteFamilyMember, type FamilyTreePersonDetails } from '../utils/familyTree';
import { getFamilyRelationshipLabels } from '../utils/familyRelationships';
import { layoutFamilyTree, TREE_NODE_HEIGHT, TREE_NODE_WIDTH } from '../utils/familyTreeLayout';
import { collectArchivePeople, personNameKey, getFamilyMaidenNames } from '../utils/people';
import { translations } from '../utils/translations';
import { PersonPicker } from './PersonPicker';
import { PersonDetailsEditor, DeleteFamilyMember } from './PersonDetailsEditor';
import { PersonAvatar, PersonAvatarPicker } from './PersonAvatar';
import './FamilyTree.css';

type Relation = { type: 'self' | 'parent' | 'spouse' | 'child'; personId?: string; familyId?: string };
type Viewport = { x: number; y: number; scale: number };
interface Props {
  tree: FamilyTreeData;
  knownPeople: string[];
  photos: Photo[];
  language: Language;
  onSave: (tree: FamilyTreeData) => Promise<void>;
  onPersonSave: (tree: FamilyTreeData, personId: string) => Promise<void>;
}
const clampScale = (scale: number, minimum = 0.01) => Math.min(2, Math.max(minimum, scale));
// Phones (portrait, or landscape with little height) get floating controls and a smaller start zoom.
// Keep these queries in sync with FamilyTree.css.
const COMPACT_QUERY = '(max-width: 639px), (max-height: 500px) and (pointer: coarse)';
// Portrait phones show person details as a bottom sheet; wider screens use a side drawer or column.
const SHEET_QUERY = '(max-width: 639px) and (min-height: 501px)';
const LANDSCAPE_QUERY = '(max-height: 500px) and (pointer: coarse)';
const DRAWER_QUERY = '(max-width: 850px), (max-height: 500px) and (pointer: coarse)';
const matches = (query: string) => typeof window !== 'undefined' && window.matchMedia(query).matches;
const homeScale = () => matches(COMPACT_QUERY) ? 0.7 : 0.9;

export const FamilyTree: React.FC<Props> = ({ tree, knownPeople, photos, language, onSave, onPersonSave }) => {
  const t = translations[language];
  const [selectedId, setSelectedId] = useState(tree.rootId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(0);
  const [relation, setRelation] = useState<Relation | null>(null);
  const [avatarPersonId, setAvatarPersonId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveLock = useRef(false);
  const canvas = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const details = useRef<HTMLElement>(null);
  const detailsOpenRef = useRef(detailsOpen);
  detailsOpenRef.current = detailsOpen;
  const tapStart = useRef<{ x: number; y: number } | null>(null);
  const handleStart = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measuredSize = useRef({ width: 0, height: 0 });
  const measureCanvas = () => {
    const bounds = canvas.current?.getBoundingClientRect();
    const next = bounds ? { width: bounds.width, height: bounds.height } : measuredSize.current;
    measuredSize.current = next;
    return next;
  };
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, scale: 0.9 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [dragging, setDragging] = useState(false);
  const focusAfterSave = useRef<string | null>(null);
  const initializedRoot = useRef<string | null>(null);
  const layout = useMemo(() => layoutFamilyTree(tree), [tree]);
  const maidenNames = useMemo(() => getFamilyMaidenNames(tree), [tree]);
  const relationshipLabels = useMemo(() => getFamilyRelationshipLabels(tree, language), [tree, language]);
  const nodes = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout]);
  const people = useMemo(() => new Map(tree.people.map(person => [person.id, person])), [tree.people]);
  const selected = people.get(selectedId) || people.get(tree.rootId);
  const parentFamily = tree.families.find(family => family.childIds.includes(selected?.id));
  const ownFamily = tree.families.find(family => family.parentIds.includes(selected?.id));
  const spouse = ownFamily?.parentIds.map(id => people.get(id)).find(person => person.id !== selected?.id);
  const photosByPerson = useMemo(() => {
    const tagged = new Map<string, Photo[]>();
    for (const photo of photos) for (const name of collectArchivePeople([photo])) {
      const key = personNameKey(name);
      if (!tagged.has(key)) tagged.set(key, []);
      tagged.get(key)!.push(photo);
    }
    return tagged;
  }, [photos]);
  const photoCounts = useMemo(() => new Map([...photosByPerson].map(([key, items]) => [key, items.length])), [photosByPerson]);
  const avatarPhotoFor = (person: FamilyTreeData['people'][number]) => photosByPerson.get(personNameKey(person.name))?.find(photo => photo.id === person.avatarPhotoId);
  const avatarPerson = people.get(avatarPersonId);
  const saveAvatar = async (photoId: string | null, crop?: AvatarCrop) => {
    if (saveLock.current || !avatarPerson) throw new Error('Avatar save is unavailable.');
    if (photoId !== null && !photosByPerson.get(personNameKey(avatarPerson.name))?.some(photo => photo.id === photoId)) throw new Error('The tagged photo is no longer available.');
    const next = { ...tree, people: tree.people.map(person => {
      if (person.id !== avatarPerson.id) return person;
      const { avatarPhotoId, avatarCrop, ...rest } = person;
      return photoId === null ? rest : { ...rest, avatarPhotoId: photoId, ...(crop ? { avatarCrop: crop } : {}) };
    }) };
    saveLock.current = true;
    try {
      await onSave(next);
      setAvatarPersonId(null);
    } finally { saveLock.current = false; }
  };

  const savePerson = async (details: FamilyTreePersonDetails) => {
    if (saveLock.current || !selected) throw new Error('A person is already being saved.');
    const next = updateFamilyMember(tree, selected.id, details, knownPeople);
    saveLock.current = true; setSaving(true);
    try { await onPersonSave(next, selected.id); }
    finally { saveLock.current = false; setSaving(false); }
  };
  const deletePerson = async () => {
    if (saveLock.current || !selected) throw new Error('A person is already being saved.');
    const next = removeFamilyMember(tree, selected.id);
    saveLock.current = true; setSaving(true);
    try {
      await onSave(next);
      setSelectedId(next.rootId);
      setDetailsOpen(false);
      focusAfterSave.current = next.rootId;
    } finally { saveLock.current = false; setSaving(false); }
  };

  // The part of the canvas not covered by open details (a bottom sheet on portrait phones, a drawer
  // from the right on tablets and landscape phones) or by the floating phone controls.
  const visibleCanvas = (viewport: { width: number; height: number }) => {
    const area = { left: matches(LANDSCAPE_QUERY) ? 64 : 0, top: 0, right: viewport.width, bottom: viewport.height - (matches(SHEET_QUERY) ? 64 : 0) };
    const panel = details.current;
    if (detailsOpenRef.current && panel && matches(DRAWER_QUERY)) {
      if (matches(SHEET_QUERY)) area.bottom = Math.max(TREE_NODE_HEIGHT * 0.5, viewport.height - panel.offsetHeight - 64);
      else area.right = Math.max(area.left + TREE_NODE_WIDTH * 0.5, viewport.width - panel.offsetWidth);
    }
    return area;
  };
  const centerPerson = (id: string, scale = viewRef.current.scale) => {
    const node = nodes.get(id);
    const viewport = measureCanvas();
    if (!node || !viewport.width) return;
    // Center in the whole canvas when nothing covers it, as on desktop.
    const area = detailsOpenRef.current ? visibleCanvas(viewport) : { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
    setView({ scale, x: (area.left + area.right) / 2 - (node.x + TREE_NODE_WIDTH / 2) * scale, y: (area.top + area.bottom) / 2 - (node.y + TREE_NODE_HEIGHT / 2) * scale });
  };
  // After the details open over the tree, pan only if the chosen card ended up hidden beneath them.
  const revealSelected = (id: string) => requestAnimationFrame(() => {
    const node = nodes.get(id);
    const viewport = measureCanvas();
    if (!node || !viewport.width || !matches(DRAWER_QUERY)) return;
    const { x, y, scale } = viewRef.current;
    const area = visibleCanvas(viewport);
    const left = x + node.x * scale, top = y + node.y * scale;
    const visible = left >= area.left && left + TREE_NODE_WIDTH * scale <= area.right && top >= area.top && top + TREE_NODE_HEIGHT * scale <= area.bottom;
    if (!visible) centerPerson(id);
  });
  const centerRoot = () => tree.rootId && centerPerson(tree.rootId, homeScale());
  const zoom = (factor: number, point?: { x: number; y: number }) => {
    if (!point) {
      // Zoom around the middle of what the user can actually see, not a spot under the details.
      const bounds = canvas.current?.getBoundingClientRect();
      const viewport = { width: bounds?.width || size.width, height: bounds?.height || size.height };
      const area = detailsOpenRef.current ? visibleCanvas(viewport) : { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
      point = { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 };
    }
    const pivot = point;
    setView(current => {
      const scale = clampScale(current.scale * factor, Math.min(0.01, current.scale));
      return { scale, x: pivot.x - (pivot.x - current.x) * scale / current.scale, y: pivot.y - (pivot.y - current.y) * scale / current.scale };
    });
  };
  const fitTree = () => {
    const { minX, minY, maxX, maxY } = layout.bounds;
    const viewport = measureCanvas();
    const compact = matches(COMPACT_QUERY);
    // Fit into the part of the canvas not covered by open details or the floating phone controls.
    const area = detailsOpenRef.current || compact ? visibleCanvas(viewport) : { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
    const margin = compact ? 16 : 32;
    const top = area.top + margin, left = area.left + margin;
    const bottom = viewport.height - area.bottom + (compact ? 8 : 48), right = viewport.width - area.right + margin;
    const scale = Math.min(1, Math.max(Number.EPSILON, Math.min((viewport.width - left - right) / Math.max(1, maxX - minX), (viewport.height - top - bottom) / Math.max(1, maxY - minY))));
    setView({ scale, x: left + (viewport.width - left - right) / 2 - (minX + maxX) / 2 * scale, y: top + (viewport.height - top - bottom) / 2 - (minY + maxY) / 2 * scale });
  };

  useLayoutEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      const previous = measuredSize.current;
      if (previous.width && previous.height) setView(current => ({ ...current, x: current.x + (next.width - previous.width) / 2, y: current.y + (next.height - previous.height) / 2 }));
      measuredSize.current = next;
      setSize(next);
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, [tree.rootId]);

  useLayoutEffect(() => {
    if (!tree.rootId || !size.width) return;
    if (initializedRoot.current !== tree.rootId) {
      initializedRoot.current = tree.rootId;
      centerPerson(tree.rootId, homeScale());
    } else if (focusAfterSave.current) {
      centerPerson(focusAfterSave.current);
      focusAfterSave.current = null;
    }
  }, [layout, size, tree.rootId]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      zoom(Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.005), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [tree.rootId]);

  useEffect(() => {
    if (!detailsOpen) setSheetExpanded(false);
    const panel = details.current;
    if (!detailsOpen || !panel) { setSheetHeight(0); return; }
    const observer = new ResizeObserver(() => setSheetHeight(matches(SHEET_QUERY) ? panel.offsetHeight : 0));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [detailsOpen, selected?.id]);

  useEffect(() => {
    if (!relation || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    element.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    return () => { if (element.open) element.close(); };
  }, [relation]);

  const relationOpener = useRef<HTMLElement | null>(null);
  const openRelation = (next: Relation) => { relationOpener.current = document.activeElement as HTMLElement | null; setError(null); setRelation(next); };
  const closeRelation = () => {
    if (saveLock.current) return;
    setRelation(null); setError(null);
    // Give focus back to the button that opened the dialog.
    requestAnimationFrame(() => { if (relationOpener.current?.isConnected) relationOpener.current.focus({ preventScroll: true }); });
  };
  const commit = async (name: string, action: Relation) => {
    if (saveLock.current) return;
    setError(null);
    let next: FamilyTreeData;
    try { next = addFamilyMember(tree, name, action); }
    catch (cause) {
      const code = (cause as { code?: keyof typeof t.treeErrors }).code;
      setError(code && t.treeErrors[code] || t.treeInvalidRelation);
      return;
    }
    saveLock.current = true;
    setSaving(true);
    try {
      await onSave(next);
      const added = next.people.find(person => personNameKey(person.name) === personNameKey(name));
      if (added) { focusAfterSave.current = added.id; setSelectedId(added.id); }
      setRelation(null);
    } catch { setError(t.treeSaveFailed); }
    finally { saveLock.current = false; setSaving(false); }
  };
  const relationTitle = relation?.type === 'parent' ? t.treeAddParent : relation?.type === 'spouse' ? t.treeAddSpouse : t.treeAddChild;
  const relationNames = relation?.familyId
    ? tree.families.find(family => family.id === relation.familyId)?.parentIds.map(id => people.get(id)?.name).join(' & ')
    : people.get(relation?.personId)?.name;
  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (!pointers.current.size) setDragging(false);
  };
  // Closing with the close button or Escape returns focus to the person's card.
  const closeDetails = () => {
    setDetailsOpen(false);
    if (selected) canvas.current?.querySelector<HTMLElement>(`[data-person-id="${CSS.escape(selected.id)}"]`)?.focus({ preventScroll: true });
  };
  // Bottom sheet handle: tap to expand or shrink, swipe down to put the sheet away.
  const dragSheet = (offset: number | null) => {
    const panel = details.current;
    if (!panel) return;
    panel.style.transition = offset === null ? '' : 'none';
    panel.style.transform = offset === null ? '' : `translateY(${offset}px)`;
  };
  const moveHandle = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (handleStart.current !== null) dragSheet(Math.max(0, event.clientY - handleStart.current));
  };
  const endHandle = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = handleStart.current;
    handleStart.current = null;
    dragSheet(null);
    if (start === null) return;
    const distance = event.clientY - start;
    if (distance > 50) { if (sheetExpanded) setSheetExpanded(false); else closeDetails(); }
    else if (distance < -50) setSheetExpanded(true);
    else setSheetExpanded(current => !current);
  };
  // On phones and tablets the details cover the tree; a tap on empty canvas puts them away.
  const tapCanvas = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = tapStart.current;
    tapStart.current = null;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6 && detailsOpenRef.current && matches(DRAWER_QUERY)) setDetailsOpen(false);
  };
  const goTo = (id: string) => { setSelectedId(id); centerPerson(id); };
  const personLink = (id: string) => <button key={id} type="button" className="ft-person-link" aria-label={`${language === 'sk' ? 'Prejsť na' : 'Go to'} ${people.get(id)?.name}`} onClick={() => goTo(id)}>{people.get(id)?.name}</button>;

  const heading = (
    <header className="ft-heading flex min-h-[38px] items-center justify-between gap-4">
      <h1 className="text-2xl font-semibold text-white">{t.familyTree}</h1>
      {tree.rootId && <span className="ft-count" aria-label={`${tree.people.length} ${t.treeMemberCount}`}><UserRound size={15} aria-hidden="true" /><span>{tree.people.length}</span><span className="ft-count-label">{t.treeMemberCount}</span></span>}
    </header>
  );

  return (
    <section className={`ft-section ${tree.rootId ? 'ft-section-populated' : ''}`} aria-label={t.familyTree}>
      {!tree.rootId && heading}

      {!tree.rootId ? (
        <div className="ft-empty">
          <div className="ft-empty-symbol"><GitBranch size={38} strokeWidth={1.4} /></div>
          <h2>{t.treeStart}</h2><p>{t.treeStartDescription}</p>
          <fieldset disabled={saving} className="ft-start-picker"><PersonPicker knownPeople={knownPeople} language={language} label={t.treeYourName} submitLabel={t.treeStartButton} onSelect={name => commit(name, { type: 'self' })} /></fieldset>
          <p className="ft-empty-note">{t.treeSharedPeople}</p>
          {error && <p role="alert" className="ft-error">{error}</p>}
          {saving && <p role="status">{t.treeSaving}</p>}
        </div>
      ) : (
        <div className={`ft-workspace ${sheetExpanded ? 'ft-sheet-expanded' : ''}`} style={{ '--ft-sheet-offset': `${sheetHeight}px` } as React.CSSProperties}
          // Fallback for browsers without overflow:clip (iOS before 16): never let the workspace scroll.
          onScroll={event => { if (event.target === event.currentTarget) event.currentTarget.scrollTo(0, 0); }}>
          <div className="ft-subheader">
            {heading}
            <div className="ft-toolbar bg-slate-800/50 p-4 rounded-xl border border-slate-700/50 backdrop-blur-sm shadow-xl" role="toolbar" aria-label={t.familyTree}>
              <div className="ft-zoom-controls">
                <button type="button" aria-label={t.treeZoomOut} title={t.treeZoomOut} disabled={view.scale <= 0.01} onClick={() => zoom(1 / 1.2)}><Minus size={17} /></button>
                <output aria-live="polite" data-testid="tree-zoom">{Math.round(view.scale * 100)}%</output>
                <button type="button" aria-label={t.treeZoomIn} title={t.treeZoomIn} disabled={view.scale >= 2} onClick={() => zoom(1.2)}><Plus size={17} /></button>
              </div>
              <div className="ft-view-controls">
                <button type="button" onClick={fitTree} title={t.treeFit} aria-label={t.treeFit}><Maximize size={16} /><span>{t.treeFit}</span></button>
                <button type="button" onClick={centerRoot} title={t.treeCenter} aria-label={t.treeCenter}><Target size={16} /><span>{t.treeCenter}</span></button>
                <button type="button" className="ft-details-toggle" onClick={() => { if (!detailsOpen && selected) revealSelected(selected.id); setDetailsOpen(!detailsOpen); }} aria-label={t.treeDetails} title={t.treeDetails} aria-expanded={detailsOpen} aria-controls="family-tree-details"><UserRound size={16} /></button>
              </div>
            </div>
          </div>
          <div className="ft-map">
            <div ref={canvas} className={`ft-canvas ${dragging ? 'ft-dragging' : ''}`} role="region" tabIndex={0} aria-label={t.treeCanvas} aria-describedby="tree-canvas-hint" data-testid="family-tree-canvas" data-scale={view.scale}
              onPointerDown={event => {
                if ((event.target as Element).closest('button') || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus({ preventScroll: true });
                event.currentTarget.setPointerCapture(event.pointerId);
                pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                tapStart.current = pointers.current.size === 1 ? { x: event.clientX, y: event.clientY } : null;
                setDragging(true);
              }}
              onPointerMove={event => {
                const previous = pointers.current.get(event.pointerId);
                if (!previous) return;
                const before = [...pointers.current.values()];
                pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                const after = [...pointers.current.values()];
                if (after.length === 1) setView(current => ({ ...current, x: current.x + event.clientX - previous.x, y: current.y + event.clientY - previous.y }));
                else {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const mid = (points: typeof before) => ({ x: (points[0].x + points[1].x) / 2 - bounds.left, y: (points[0].y + points[1].y) / 2 - bounds.top });
                  const distance = (points: typeof before) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
                  const oldMid = mid(before), newMid = mid(after);
                  setView(current => {
                    const scale = clampScale(current.scale * distance(after) / Math.max(1, distance(before)), Math.min(0.01, current.scale));
                    return { scale, x: newMid.x - (oldMid.x - current.x) * scale / current.scale, y: newMid.y - (oldMid.y - current.y) * scale / current.scale };
                  });
                }
              }}
              onPointerUp={event => { tapCanvas(event); endPointer(event); }} onPointerCancel={endPointer} onLostPointerCapture={endPointer}
              onKeyDown={event => {
                // Escape from the canvas or a card puts away details that cover the tree.
                if (event.key === 'Escape' && detailsOpenRef.current && matches(DRAWER_QUERY)) { event.preventDefault(); setDetailsOpen(false); return; }
                if (event.target !== event.currentTarget) return;
                const offsets: Record<string, [number, number]> = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
                const offset = offsets[event.key];
                if (offset) { event.preventDefault(); setView(current => ({ ...current, x: current.x + offset[0], y: current.y + offset[1] })); }
                else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); }
                else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); }
                else if (event.key === '0' || event.key === 'Home') { event.preventDefault(); centerRoot(); }
              }}>
              <div className="ft-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
                <svg className="ft-connections" width="1" height="1" aria-hidden="true">
                  {layout.families.map(family => <g key={family.id} data-family-id={family.id} data-route-lane={family.lane} data-route-y={family.y}>
                    {family.partnerLine && <path className="ft-spouse-line" d={`M ${family.partnerLine.x1} ${family.partnerLine.y} H ${family.partnerLine.x2}`} />}
                    {family.stem && <path data-connector="stem" d={`M ${family.stem.x} ${family.stem.y1} V ${family.stem.y2}`} />}
                    {family.busSegments.map((segment, index) => <path key={`bus-${index}`} data-connector="bus" d={`M ${segment.x1} ${segment.y} H ${segment.x2}`} />)}
                    {family.branches.map(branch => <path key={branch.personId} data-child-id={branch.personId} d={`M ${branch.x} ${branch.y1} V ${branch.y2}`} />)}
                    {family.junctions.map(point => <circle key={point.x} className="ft-family-junction" cx={point.x} cy={point.y} r="2.5" />)}
                    {family.union && <circle cx={family.union.x} cy={family.union.y} r="5" className="ft-union-dot" />}
                  </g>)}
                </svg>
                {layout.nodes.map(node => {
                  const person = people.get(node.id);
                  const isRoot = node.id === tree.rootId;
                  const maidenName = maidenNames.get(node.id)?.display;
                  const accessibleDescription = [relationshipLabels.get(node.id), maidenName ? `${t.treeMaidenName}: ${maidenName}` : ''].filter(Boolean).join(' · ');
                  const count = photoCounts.get(personNameKey(person.name)) || 0;
                  return <button key={node.id} type="button" className={`ft-node ${selected?.id === node.id ? 'ft-node-selected' : ''} ${isRoot ? 'ft-node-root' : ''}`} aria-label={`${t.treeSelect} ${person.name}`} aria-pressed={selected?.id === node.id} aria-description={accessibleDescription} disabled={saving} data-person-id={node.id}
                    onClick={() => { setSelectedId(node.id); setDetailsOpen(true); revealSelected(node.id); }} onFocus={() => { if (document.activeElement?.matches(':focus-visible')) centerPerson(node.id); }}
                    style={{ left: node.x, top: node.y, width: TREE_NODE_WIDTH, height: TREE_NODE_HEIGHT }}>
                    <span className="ft-avatar"><PersonAvatar person={person} photo={avatarPhotoFor(person)} /></span>
                    <span className="ft-node-content"><span className="ft-node-role" title={relationshipLabels.get(node.id)}>{relationshipLabels.get(node.id)}</span><strong>{person.name}</strong>{maidenName && <span className="ft-maiden-name" aria-label={`${t.treeMaidenName}: ${maidenName}`} title={`${t.treeMaidenName}: ${maidenName}`}>({maidenName})</span>}<span className="ft-photo-count">{count} {t.treePhotos}</span></span>
                  </button>;
                })}
              </div>
            </div>
            <p id="tree-canvas-hint" className="ft-canvas-hint">{t.treeCanvasHint}</p>
          </div>
          {selected && <aside ref={details} id="family-tree-details" className={`ft-details ${detailsOpen ? 'ft-details-open' : ''}`} aria-label={selected.name} aria-busy={saving} onKeyDown={event => { if (event.key === 'Escape') closeDetails(); }}>
            <div className="ft-detail-header">
            <button type="button" className="ft-sheet-handle" aria-label={sheetExpanded ? t.treeShrinkDetails : t.treeExpandDetails} aria-expanded={sheetExpanded} aria-controls="family-tree-details"
              onPointerDown={event => { handleStart.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); }}
              onPointerMove={moveHandle} onPointerUp={endHandle} onPointerCancel={() => { handleStart.current = null; dragSheet(null); }}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSheetExpanded(current => !current); } }}><span aria-hidden="true" /></button>
            <button type="button" className="ft-details-close" aria-label={t.close} onClick={closeDetails}><X size={20} /></button>
            <div className="ft-detail-top">
              <button type="button" className="ft-detail-icon ft-avatar-button" disabled={saving} aria-label={t.treeChangeAvatar.replace('{name}', selected.name)} title={t.treeChangeAvatar.replace('{name}', selected.name)} onClick={() => setAvatarPersonId(selected.id)}>
                <PersonAvatar person={selected} photo={avatarPhotoFor(selected)} />
                <span className="ft-avatar-camera" aria-hidden="true"><Camera size={13} /></span>
              </button>
              <span className="ft-node-role">{relationshipLabels.get(selected.id)}</span><h2>{selected.name}</h2>{maidenNames.get(selected.id)?.display && <p className="ft-detail-maiden">{t.treeMaidenName}: {maidenNames.get(selected.id)!.display}</p>}<p>{photoCounts.get(personNameKey(selected.name)) || 0} {t.treePhotos}</p>
            </div>
            </div>
            <PersonDetailsEditor key={selected.id} person={selected} maidenNameInfo={maidenNames.get(selected.id)!} language={language} disabled={saving} onSave={savePerson} />
            <div className="ft-detail-section"><h3>{t.treeParents}</h3>
              {parentFamily?.parentIds.length ? <div className="ft-name-list">{parentFamily.parentIds.map(personLink)}</div> : <p>{t.treeNoParents}</p>}
              {(!parentFamily || parentFamily.parentIds.length < 2) && <button type="button" className="ft-action" disabled={saving} onClick={() => openRelation({ type: 'parent', personId: selected.id })}><Plus size={16} />{t.treeAddParent}</button>}
            </div>
            <div className="ft-detail-section"><h3>{t.treeSpouse}</h3>
              {spouse ? personLink(spouse.id) : <><p>{t.treeNoSpouse}</p><button type="button" className="ft-action" disabled={saving} onClick={() => openRelation({ type: 'spouse', personId: selected.id })}><Heart size={15} />{t.treeAddSpouse}</button></>}
            </div>
            {ownFamily?.parentIds.length === 2 && <div className="ft-detail-section"><h3>{t.treeCouple}</h3><p className="ft-couple-names">{ownFamily.parentIds.map(id => people.get(id)?.name).join(' & ')}</p>
              <h3 className="ft-children-heading">{t.treeChildren}</h3>
              {ownFamily.childIds.length ? <div className="ft-name-list">{ownFamily.childIds.map(personLink)}</div> : <p>{t.treeNoChildren}</p>}
              <button type="button" className="ft-action ft-action-primary" disabled={saving} onClick={() => openRelation({ type: 'child', familyId: ownFamily.id })}><UserPlus size={16} />{t.treeAddChild}</button>
            </div>}
            <p className="ft-detail-hint">{t.treeSelectedHint}</p>
            <DeleteFamilyMember key={`delete-${selected.id}`} person={selected} language={language} disabled={saving} canDelete={canDeleteFamilyMember(tree, selected.id)} resetsRoot={selected.id === tree.rootId && tree.people.length > 1} onDelete={deletePerson} />
          </aside>}
        </div>
      )}
      {avatarPerson && <PersonAvatarPicker person={avatarPerson} photos={photosByPerson.get(personNameKey(avatarPerson.name)) || []} language={language} onSelect={saveAvatar} onClose={() => setAvatarPersonId(null)} />}
      {relation && <dialog ref={dialog} className="ft-dialog" aria-labelledby="tree-dialog-title" aria-describedby="tree-dialog-description" onCancel={event => { event.preventDefault(); closeRelation(); }}>
        <div className="ft-dialog-header"><h2 id="tree-dialog-title">{relationTitle}</h2><button type="button" onClick={closeRelation} disabled={saving} aria-label={t.close}><X size={20} /></button></div>
        <p className="ft-dialog-context">{t.treeRelationFor}: <strong>{relationNames}</strong></p>
        <p id="tree-dialog-description">{t.treeSharedPeople}</p>
        <fieldset disabled={saving}><PersonPicker knownPeople={knownPeople} language={language} onSelect={name => commit(name, relation)} autoFocus /></fieldset>
        {error && <p role="alert" className="ft-error">{error}</p>}
        {saving && <p role="status">{t.treeSaving}</p>}
        <button type="button" className="ft-cancel" disabled={saving} onClick={closeRelation}>{t.treeCancel}</button>
      </dialog>}
    </section>
  );
};


