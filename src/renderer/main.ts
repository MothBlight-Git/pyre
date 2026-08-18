/**
 * Renderer bootstrap: settings → grid metrics, notes → grid, variable tick,
 * change subscription, actions, keyboard, composer, drag, sheets, resize.
 */
import type { Note, Settings } from '../shared/types';
import { DEFAULT_BANK_MINUTES } from '../shared/heat';
import { parseLine, toLine, formatDue, displayTopic } from '../shared/parse';
import { GridView } from './grid-view';
import { installDrag } from './drag';
import { installComposer } from './composer';
import { Sheets } from './sheets';
import type { NoteAction } from './note';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rail = $('rail');
const surface = $('surface');
const dropTarget = $('drop-target');
const pip = $('flare-pip');
const pipCount = $('flare-count');
const emptyEl = $('empty');
const countEl = $('rail-count');
const composerInput = $<HTMLInputElement>('composer-input');
const chips = $('composer-chips');
const writeError = $('write-error');
const resizeHandle = $('rail-resize');

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let settings: Settings;
let allNotes: Note[] = [];
let tickTimer: number | null = null;

// ---------------------------------------------------------------- grid + actions

const grid = new GridView(rail, surface, pip, pipCount, { onAction }, emptyEl, countEl);

function onAction(id: string, action: NoteAction, ev: Event): void {
  switch (action) {
    case 'snuff': return void snuff(id);
    case 'edit': return void editInPlace(id);
    case 'delete': return void remove(id);
    case 'release': return void window.pyre.release(id);
    case 'bank': return void bank(id, (ev as MouseEvent).shiftKey);
  }
}

async function snuff(id: string): Promise<void> {
  const e = grid.get(id);
  if (!e || e.leaving) return;
  if (reducedMotion()) { await window.pyre.snuff(id); return; }
  e.leaving = true;
  const root = e.refs.root;
  root.dataset.snuffing = '';
  // Two grey smoke particles after the front has died back (220ms), drifting 500ms.
  window.setTimeout(() => {
    for (let i = 0; i < 2; i++) {
      const p = document.createElement('div');
      p.className = 'note__snuff-smoke';
      p.style.left = `${30 + i * 28}%`;
      p.style.bottom = `${18 + i * 6}%`;
      p.style.animationDelay = `${i * 60}ms`;
      root.appendChild(p);
    }
  }, 220);
  // Then slide right out over 280ms.
  window.setTimeout(() => {
    root.dataset.snuffing = 'out';
    const dir = settings.dockSide === 'left' ? '-120%' : '120%';
    root.style.transform = `translate3d(calc(var(--col) * var(--pitch) + ${dir}), calc(var(--row) * var(--pitch)), 0)`;
  }, 720);
  window.setTimeout(async () => {
    root.remove();
    grid.entries.delete(id);
    await window.pyre.snuff(id);
  }, 1000);
}

async function remove(id: string): Promise<void> {
  const e = grid.get(id);
  if (!e || e.leaving) return;
  if (reducedMotion()) { await window.pyre.remove(id); return; }
  e.leaving = true;
  e.refs.root.dataset.deleting = '';
  window.setTimeout(async () => {
    e.refs.root.remove();
    grid.entries.delete(id);
    await window.pyre.remove(id);
  }, 190);
}

async function bank(id: string, restOfDay: boolean): Promise<void> {
  const e = grid.get(id);
  if (!e) return;
  if (e.burn.state === 'banked') { await window.pyre.unbank(id); return; }
  let until: Date;
  if (restOfDay) { until = new Date(); until.setHours(23, 59, 0, 0); }
  else until = new Date(Date.now() + DEFAULT_BANK_MINUTES * 60000);
  await window.pyre.bank(id, until.toISOString());
}

// ---------------------------------------------------------------- edit in place

function editInPlace(id: string): void {
  const e = grid.get(id);
  if (!e || e.leaving) return;
  const card = e.refs.card;
  if (card.querySelector('.note__edit')) return;

  const wrap = document.createElement('div');
  wrap.className = 'note__edit';
  const ta = document.createElement('textarea');
  ta.value = toLine(e.note);
  ta.setAttribute('aria-label', 'Edit note: topic / comment / due');
  ta.spellcheck = false;
  const hint = document.createElement('div');
  hint.className = 'note__edit-hint';
  wrap.append(ta, hint);
  card.appendChild(wrap);
  e.refs.root.dataset.editing = '';

  const preview = () => {
    const p = parseLine(ta.value, { defaultTime: settings.defaultDueTime });
    hint.textContent = p.valid
      ? `${displayTopic(p.topic)} · ${p.due ? formatDue(p.due) : 'no due'}`
      : 'topic / comment / due';
  };
  const close = () => { wrap.remove(); delete e.refs.root.dataset.editing; e.refs.root.focus({ preventScroll: true }); };
  ta.addEventListener('input', preview);
  ta.addEventListener('keydown', async (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      const p = parseLine(ta.value, { defaultTime: settings.defaultDueTime });
      if (!p.valid) return;
      close();
      await window.pyre.update(id, { topic: p.topic, comment: p.comment, due: p.due });
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  });
  ta.addEventListener('blur', () => { window.setTimeout(() => { if (wrap.isConnected) close(); }, 0); });
  preview();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ---------------------------------------------------------------- keyboard on notes

surface.addEventListener('keydown', (ev) => {
  const root = (ev.target as HTMLElement).closest('.note') as HTMLElement | null;
  if (!root || (ev.target as HTMLElement).closest('textarea, input')) return;
  const id = root.dataset.id!;
  const k = ev.key;
  if (k === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void snuff(id); }
  else if (k === 'Enter') { ev.preventDefault(); editInPlace(id); }
  else if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); void remove(id); }
  else if (k === 'b' || k === 'B') { ev.preventDefault(); void bank(id, ev.shiftKey); }
  else if (k === 'r' || k === 'R') { ev.preventDefault(); void window.pyre.release(id); }
});

// ---------------------------------------------------------------- tick

function scheduleTick(ms: number): void {
  if (tickTimer) window.clearTimeout(tickTimer);
  tickTimer = window.setTimeout(runTick, ms);
}
function runTick(): void {
  const next = grid.tick(new Date());
  scheduleTick(next);
}

// ---------------------------------------------------------------- data flow

function applyNotes(notes: Note[]): void {
  allNotes = notes;
  grid.setNotes(notes.filter((n) => !n.done));
  if (sheets.isOpen()) sheets.renderArchive(allNotes);
  scheduleTick(grid.tick(new Date()));
}

function applySettings(s: Settings): void {
  settings = s;
  rail.dataset.dock = s.dockSide;
  grid.setRailWidth(s.railWidth);
}

// ---------------------------------------------------------------- composer

const composer = installComposer({
  input: composerInput,
  chips,
  cmdChip: $('composer-cmd'),
  defaultTime: () => settings.defaultDueTime,
  onCommit: async (p) => {
    await window.pyre.add({ topic: p.topic, comment: p.comment, due: p.due, source: 'user' });
  },
  onCommand: async (c) => {
    if (c.kind === 'quit') await window.pyre.quit();
  },
});

// ---------------------------------------------------------------- sheets

const sheets = new Sheets(
  $('sheet-archive'), $('archive-list'), $('sheet-settings'), $('settings-body'),
  () => composer.focus(),
);
$('btn-archive').addEventListener('click', () => sheets.toggleArchive(() => allNotes));
$('btn-settings').addEventListener('click', () => void sheets.toggleSettings());
window.addEventListener('keydown', (ev) => {
  if (ev.key === ',' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void sheets.toggleSettings(); }
});

// ---------------------------------------------------------------- drag

installDrag({
  rail, surface, dropTarget, grid,
  onCommit: async (id, slot, displaced) => {
    if (displaced.length) await window.pyre.correct(displaced);
    await window.pyre.move(id, slot.col, slot.row);
  },
});

// ---------------------------------------------------------------- resize handle

(() => {
  let start: { x: number; width: number; dock: 'left' | 'right' } | null = null;
  let raf = 0;
  let pendingWidth = 0;
  resizeHandle.addEventListener('pointerdown', (ev) => {
    start = { x: ev.screenX, width: settings.railWidth, dock: settings.dockSide };
    resizeHandle.setPointerCapture(ev.pointerId);
  });
  resizeHandle.addEventListener('pointermove', (ev) => {
    if (!start) return;
    const delta = start.dock === 'right' ? start.x - ev.screenX : ev.screenX - start.x;
    pendingWidth = Math.max(280, Math.min(420, Math.round(start.width + delta)));
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; void window.pyre.resizeRail(pendingWidth); });
  });
  const end = () => { start = null; };
  resizeHandle.addEventListener('pointerup', end);
  resizeHandle.addEventListener('pointercancel', end);
})();

// ---------------------------------------------------------------- bridge events

function wireBridge(): void {
  window.pyre.onChange((notes) => applyNotes(notes));
  window.pyre.onSettings((s) => applySettings(s));
  window.pyre.onWriteError((msg) => { writeError.textContent = msg; writeError.hidden = false; });
  window.pyre.onWriteOk(() => { writeError.hidden = true; });
  window.pyre.onFocusComposer(() => { sheets.close(); composer.focus(); });
  window.pyre.onOpenSettings(() => void sheets.toggleSettings());
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) runTick(); });

// ---------------------------------------------------------------- boot

(async () => {
  if (!window.pyre) {
    // Outside Electron (vite dev / plain browser): in-memory bridge for visual checks.
    (await import('./mock-bridge')).installMockBridge();
  }
  wireBridge();
  applySettings(await window.pyre.settings());
  applyNotes(await window.pyre.list());
  // Re-tick when the clock jumps (sleep/resume): a cheap 60s guard on top of the variable tick.
  window.setInterval(() => runTick(), 60_000);
})();
