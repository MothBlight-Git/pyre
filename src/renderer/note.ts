/**
 * Note element factory + state binding.
 *
 * DOM order is LOAD-BEARING (CLAUDE.md §10): every fire layer is a sibling of
 * the card at inset:0 so it shares the card's box:
 *   smoke → backglow → halo → ember line → tongues → CARD → embers → wash(z 99)
 * All layers are always created; state flips toggle `hidden` on the ones the
 * reference markup omits per state (note-example.html), so state changes are
 * attribute flips, not DOM churn (which would restart the CSS animations).
 */
import type { Note } from '../shared/types';
import type { Burn, BurnState } from '../shared/heat';
import { displayTopic } from '../shared/parse';

export interface NoteRefs {
  root: HTMLElement;
  card: HTMLElement;
  smoke: HTMLElement;
  halo: HTMLElement;
  emberLine: HTMLElement;
  tongues: HTMLElement;
  topic: HTMLElement;
  dueSubject: HTMLElement;
  dueFoot: HTMLElement;
  bankedChip: HTMLElement;
  comment: HTMLElement;
  emberHost: HTMLElement;
  wash: HTMLElement;
  /** Last applied state, to detect tier crossings + ember respawn. */
  lastState: BurnState | null;
  lastBurn: Burn | null;
}

export type NoteAction = 'snuff' | 'edit' | 'delete' | 'release' | 'bank';

export interface NoteHandlers {
  onAction: (id: string, action: NoteAction, ev: Event) => void;
}

const el = (cls: string, tag = 'div'): HTMLElement => {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
};

const ACTIONS: Array<{ action: NoteAction; glyph: string; title: string; cls?: string }> = [
  { action: 'snuff', glyph: '✓', title: 'Mark done (Ctrl+Enter)' },
  { action: 'edit', glyph: '✎', title: 'Edit (Enter)' },
  { action: 'bank', glyph: '◐', title: 'Bank 2h (B) · Shift+B rest of day' },
  { action: 'release', glyph: '⇱', title: 'Release to auto (R)', cls: 'note__release' },
  { action: 'delete', glyph: '✕', title: 'Delete (Del)' },
];

function actionBar(id: string, h: NoteHandlers): HTMLElement {
  const bar = el('note__actions', 'span');
  for (const a of ACTIONS) {
    const b = el('note__action' + (a.cls ? ' ' + a.cls : ''), 'button') as HTMLButtonElement;
    b.type = 'button';
    b.textContent = a.glyph;
    b.title = a.title;
    b.setAttribute('aria-label', a.title);
    b.tabIndex = -1;
    b.dataset.action = a.action;
    b.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't start a drag
    b.addEventListener('click', (e) => { e.stopPropagation(); h.onAction(id, a.action, e); });
    bar.appendChild(b);
  }
  return bar;
}

export function createNoteElement(note: Note, h: NoteHandlers): NoteRefs {
  const root = el('note');
  root.dataset.id = note.id;
  root.tabIndex = 0;
  root.setAttribute('role', 'listitem');

  const smoke = el('note__smoke');
  const backglow = el('note__backglow');
  const halo = el('note__halo');
  const emberLine = el('note__ember-line');
  const tongues = el('note__tongues');
  tongues.appendChild(el('note__tongue--l'));
  tongues.appendChild(el('note__tongue--r'));

  const card = el('note__card');
  const subject = el('note__subject');
  const topic = el('note__topic', 'span');
  const subjectRight = el('note__subject-right', 'span');
  const dueSubject = el('note__due', 'span');
  const bankedChip = el('note__banked-chip', 'span');
  bankedChip.textContent = 'BANKED';
  bankedChip.hidden = true;
  subjectRight.append(dueSubject, bankedChip, actionBar(note.id, h));
  subject.append(topic, subjectRight);

  const comment = el('note__comment');
  const foot = el('note__foot');
  const dueFoot = el('note__due', 'span');
  foot.append(dueFoot, actionBar(note.id, h));
  card.append(subject, comment, foot);

  const emberHost = el('note__embers');
  emberHost.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  const wash = el('note__wash');

  root.append(smoke, backglow, halo, emberLine, tongues, card, emberHost, wash);

  const refs: NoteRefs = {
    root, card, smoke, halo, emberLine, tongues, topic, dueSubject, dueFoot, bankedChip,
    comment, emberHost, wash, lastState: null, lastBurn: null,
  };
  bindContent(refs, note);
  return refs;
}

/** Text + provenance/placement markers. Call when the record changes. */
export function bindContent(r: NoteRefs, note: Note): void {
  r.topic.textContent = displayTopic(note.topic);
  r.comment.textContent = note.comment;
  r.root.dataset.placement = note.placement.mode;
  r.root.dataset.source = note.source === 'user' ? 'user' : 'agent';
}

export const HOT: ReadonlySet<BurnState> = new Set(['due', 'burning', 'critical', 'overdue', 'gone-out', 'banked']);
export const CROSSING_TIERS: ReadonlySet<BurnState> = new Set(['due', 'burning', 'critical', 'overdue']);

/** Per-tick binding of the derived values. Never persisted. Returns whether a fire tier was crossed. */
export function bindBurn(r: NoteRefs, note: Note, b: Burn, now: Date): boolean {
  r.root.style.setProperty('--burn', `${b.burn}%`);
  r.root.style.setProperty('--warmth', String(b.warmth));
  r.root.dataset.state = b.state;

  const hot = HOT.has(b.state);
  if (hot) r.root.dataset.hot = ''; else delete r.root.dataset.hot;
  if (hot) r.card.dataset.burning = ''; else delete r.card.dataset.burning;

  // Layers the reference markup omits per state.
  r.emberLine.hidden = !hot;
  r.halo.hidden = b.state === 'cold';
  r.tongues.hidden = b.state !== 'overdue';
  r.smoke.hidden = !(b.state === 'gone-out' || b.state === 'banked');
  r.bankedChip.hidden = b.state !== 'banked';

  r.dueSubject.textContent = b.label;
  r.dueFoot.textContent = b.label;
  const dueTitle = note.due ? new Date(note.due).toLocaleString() : '';
  r.dueSubject.title = dueTitle;
  r.dueFoot.title = dueTitle;
  if (b.state === 'banked' && note.bankedUntil) {
    const mins = Math.max(0, Math.round((new Date(note.bankedUntil).getTime() - now.getTime()) / 60000));
    r.bankedChip.title = `Banked · ${mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h'} left`;
  }

  r.root.setAttribute('aria-label', accessibleName(note, b));

  const prev = r.lastState;
  const crossed = prev !== null && prev !== b.state && (CROSSING_TIERS.has(b.state) || CROSSING_TIERS.has(prev));
  r.lastState = b.state;
  r.lastBurn = b;
  return crossed;
}

export function accessibleName(note: Note, b: Burn): string {
  const parts = [displayTopic(note.topic) + '.', note.comment + '.'];
  if (b.minutesToDue !== null) {
    const m = b.minutesToDue;
    const human = humanDuration(Math.abs(m));
    parts.push(m >= 0 ? `Due in ${human}.` : `Overdue by ${human}.`);
    if (b.state === 'banked') parts.push('Banked.');
    if (b.state === 'gone-out') parts.push('Gone out.');
  }
  if (note.placement.mode === 'manual') {
    parts.push(`Pinned to column ${note.placement.col + 1}, row ${note.placement.row + 1}.`);
  }
  if (note.source !== 'user') parts.push('Created by an agent.');
  return parts.join(' ');
}

export function humanDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(m / 1440);
  return `${d} day${d === 1 ? '' : 's'}`;
}
