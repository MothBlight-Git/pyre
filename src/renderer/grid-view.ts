/**
 * Grid view: owns the note elements, applies layout() (FLIP via the transform
 * transition on --col/--row), drives the per-tick burn binding, embers and the
 * flare pip. Persists layout corrections so pins never drift on resize.
 */
import type { Note } from '../shared/types';
import { evaluate, nextTickMs, type Burn } from '../shared/heat';
import { layout, gridMetrics, hiddenFires, GAP, GUTTER, type Slot, type PlaceableNote } from '../shared/grid';
import { createNoteElement, bindContent, bindBurn, type NoteRefs, type NoteHandlers } from './note';
import { syncEmbers } from './embers';

export interface GridMetrics { cols: number; noteSize: number; pitch: number; gutter: number }

export interface Entry {
  note: Note;
  refs: NoteRefs;
  slot: Slot;
  burn: Burn;
  /** Set while a snuff/delete animation plays; the element must survive a change event. */
  leaving: boolean;
}

export class GridView {
  readonly entries = new Map<string, Entry>();
  metrics: GridMetrics = { cols: 2, noteSize: 144, pitch: 164, gutter: GUTTER };
  private notes: Note[] = [];
  private correctTimer: number | null = null;
  private pendingCorrections = new Map<string, Slot>();
  /** During a drag: the dragged id and its hypothetical target. */
  private dragOverride: { id: string; slot: Slot } | null = null;
  private crossingTimers = new Map<string, number>();

  constructor(
    private rail: HTMLElement,
    private surface: HTMLElement,
    private pip: HTMLElement,
    private pipCount: HTMLElement,
    private handlers: NoteHandlers,
    private empty: HTMLElement,
    private countEl: HTMLElement,
  ) {
    pip.addEventListener('click', () => this.scrollToHottestHidden());
    rail.addEventListener('scroll', () => this.updatePip(), { passive: true });
  }

  // ---------------------------------------------------------------- metrics

  setRailWidth(width: number): void {
    const m = gridMetrics(width);
    const gutter = m.cols === 1 ? Math.max(GUTTER, Math.floor((width - m.noteSize) / 2)) : GUTTER;
    this.metrics = { cols: m.cols, noteSize: m.noteSize, pitch: m.noteSize + GAP, gutter };
    this.rail.style.setProperty('--note-size', `${m.noteSize}px`);
    // --pitch is declared on :root in grid-system.css, where --note-size is still
    // burn-system's 176px; a var() resolves where it is declared, so re-declare
    // pitch here on the rail with the real note size.
    this.rail.style.setProperty('--pitch', `${m.noteSize + GAP}px`);
    this.rail.style.setProperty('--cols', String(m.cols));
    this.rail.style.setProperty('--gutter', `${gutter}px`);
    this.rail.dataset.cols = String(m.cols);
    this.applyLayout(new Date());
  }

  // ---------------------------------------------------------------- notes

  /** Replace the note list (live, non-done notes). Diffs elements. */
  setNotes(notes: Note[], now = new Date()): void {
    this.notes = notes;
    const seen = new Set<string>();
    for (const n of notes) {
      seen.add(n.id);
      let e = this.entries.get(n.id);
      if (!e) {
        const refs = createNoteElement(n, this.handlers);
        e = { note: n, refs, slot: { col: 0, row: 0 }, burn: evaluate(n, now), leaving: false };
        this.entries.set(n.id, e);
        // Position BEFORE insertion so entry doesn't animate from (0,0).
        this.positionForNew(e, now);
        refs.root.dataset.entering = '';
        this.surface.appendChild(refs.root);
        window.setTimeout(() => { delete refs.root.dataset.entering; }, 340);
      } else {
        e.note = n;
        bindContent(e.refs, n);
      }
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id) && !e.leaving) {
        e.refs.root.remove();
        this.entries.delete(id);
      }
    }
    this.empty.hidden = notes.length > 0;
    this.countEl.textContent = notes.length ? `${notes.length} on the wall` : '';
    this.tick(now);
  }

  private positionForNew(e: Entry, now: Date): void {
    const { slots } = this.computeLayout(now);
    const s = slots.get(e.note.id) ?? { col: 0, row: 0 };
    e.slot = s;
    e.refs.root.style.setProperty('--col', String(s.col));
    e.refs.root.style.setProperty('--row', String(s.row));
    bindBurn(e.refs, e.note, e.burn, now);
  }

  get(id: string): Entry | undefined { return this.entries.get(id); }

  liveNotes(): Note[] { return this.notes; }

  // ---------------------------------------------------------------- tick

  /** Recompute every derived value. Returns ms until the next tick. */
  tick(now = new Date()): number {
    let soonest: number | null = null;
    const ordered: Array<{ refs: NoteRefs; state: Burn['state']; burn: number }> = [];
    for (const e of this.entries.values()) {
      if (e.leaving) continue;
      const b = evaluate(e.note, now);
      e.burn = b;
      const crossed = bindBurn(e.refs, e.note, b, now);
      if (crossed) this.flagCrossing(e);
      ordered.push({ refs: e.refs, state: b.state, burn: b.burn });
      if (b.minutesToDue !== null && b.state !== 'banked') {
        soonest = soonest === null ? b.minutesToDue : Math.min(soonest, b.minutesToDue);
      }
    }
    ordered.sort((a, b) => b.burn - a.burn);
    syncEmbers(ordered);
    this.applyLayout(now);
    return Math.max(1000, nextTickMs(soonest));
  }

  private flagCrossing(e: Entry): void {
    const id = e.note.id;
    e.refs.root.dataset.crossing = '';
    const t = this.crossingTimers.get(id);
    if (t) window.clearTimeout(t);
    this.crossingTimers.set(id, window.setTimeout(() => {
      delete e.refs.root.dataset.crossing;
      this.crossingTimers.delete(id);
    }, 600));
  }

  // ---------------------------------------------------------------- layout

  private placeables(now: Date): PlaceableNote[] {
    const list: PlaceableNote[] = [];
    for (const n of this.notes) {
      const e = this.entries.get(n.id);
      if (e?.leaving) continue;
      if (this.dragOverride && this.dragOverride.id === n.id) {
        // The dragged note claims its target ahead of every other pin (pinnedAt '' sorts first).
        list.push({ ...n, placement: { mode: 'manual', col: this.dragOverride.slot.col, row: this.dragOverride.slot.row, pinnedAt: '' } });
      } else {
        list.push(n);
      }
    }
    return list;
  }

  computeLayout(now: Date) {
    return layout(this.placeables(now), this.metrics.cols, now);
  }

  applyLayout(now = new Date()): void {
    const { slots, corrections } = this.computeLayout(now);
    let maxRow = 0;
    for (const [id, s] of slots) {
      const e = this.entries.get(id);
      if (!e) continue;
      maxRow = Math.max(maxRow, s.row);
      if (e.slot.col !== s.col || e.slot.row !== s.row) {
        e.slot = s;
        if (!(this.dragOverride && this.dragOverride.id === id)) {
          e.refs.root.style.setProperty('--col', String(s.col));
          e.refs.root.style.setProperty('--row', String(s.row));
        }
      }
    }
    // Persist corrections (never for the hypothetical drag placement).
    for (const [id, s] of corrections) {
      if (this.dragOverride && this.dragOverride.id === id) continue;
      this.pendingCorrections.set(id, s);
    }
    if (this.pendingCorrections.size && this.correctTimer === null) {
      this.correctTimer = window.setTimeout(() => this.flushCorrections(), 250);
    }
    const rows = slots.size ? maxRow + 1 : 0;
    this.surface.style.height = rows ? `${rows * this.metrics.pitch - GAP + 8 + 40}px` : '0px';
    this.updatePip();
  }

  private flushCorrections(): void {
    this.correctTimer = null;
    if (!this.pendingCorrections.size) return;
    const list = [...this.pendingCorrections].map(([id, s]) => ({ id, col: s.col, row: s.row }));
    this.pendingCorrections.clear();
    void window.pyre.correct(list);
  }

  /** Called by drag: set/clear the hypothetical placement and reflow live. */
  setDragOverride(o: { id: string; slot: Slot } | null): void {
    this.dragOverride = o;
    this.applyLayout(new Date());
  }

  /** Corrections that committing a drop at `slot` would cause to OTHER pinned notes. */
  displacedByDrop(id: string, slot: Slot): Array<{ id: string; col: number; row: number }> {
    const prev = this.dragOverride;
    this.dragOverride = { id, slot };
    const { corrections } = this.computeLayout(new Date());
    this.dragOverride = prev;
    return [...corrections].filter(([cid]) => cid !== id).map(([cid, s]) => ({ id: cid, col: s.col, row: s.row }));
  }

  // ---------------------------------------------------------------- pip

  private visibleRowRange(): { start: number; end: number } {
    const surfaceTop = this.surface.offsetTop; // composer height above the grid
    const scrollTop = this.rail.scrollTop;
    const viewH = this.rail.clientHeight;
    const pitch = this.metrics.pitch;
    const start = Math.max(0, Math.floor((scrollTop - surfaceTop) / pitch));
    const end = Math.max(start, Math.ceil((scrollTop + viewH - surfaceTop - this.metrics.noteSize * 0.5) / pitch));
    return { start, end };
  }

  private hiddenFireIds(): string[] {
    const { start, end } = this.visibleRowRange();
    const slots = new Map<string, Slot>();
    for (const e of this.entries.values()) slots.set(e.note.id, e.slot);
    const notes = this.notes.filter((n) => !this.entries.get(n.id)?.leaving);
    const below = hiddenFires(notes, slots, end, new Date());
    const above = notes.filter((n) => {
      const s = slots.get(n.id);
      const e = this.entries.get(n.id);
      return s && e && s.row < start && e.burn.burn > 0;
    }).map((n) => n.id);
    return [...new Set([...below, ...above])];
  }

  updatePip(): void {
    const ids = this.hiddenFireIds();
    this.pip.hidden = ids.length === 0;
    this.pipCount.textContent = String(ids.length);
    this.pip.setAttribute('aria-label', ids.length === 1
      ? 'One burning note is out of view. Scroll to it.'
      : `${ids.length} burning notes are out of view. Scroll to the hottest.`);
  }

  private scrollToHottestHidden(): void {
    const ids = this.hiddenFireIds();
    if (!ids.length) return;
    let best: Entry | null = null;
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e && (!best || e.burn.burn > best.burn.burn)) best = e;
    }
    if (best) {
      const y = this.surface.offsetTop + best.slot.row * this.metrics.pitch;
      this.rail.scrollTo({ top: Math.max(0, y - 8), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      best.refs.root.focus({ preventScroll: true });
    }
  }
}
