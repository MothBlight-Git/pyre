/**
 * Pointer drag (CLAUDE.md §3.3). Pointer Events only.
 *
 *  pointerdown  capture, record offset, do not lift yet
 *  4px          lift: data-dragging, z 400; burning notes keep their bloom
 *  move         note follows the pointer (transition off); slotAtPoint() snaps
 *               the drop target to the nearest cell centre; others reflow live
 *  edge         within 40px of top/bottom → auto-scroll 6px/frame
 *  pointerup    commit: placement = manual @ target, data-settling 200ms
 *  Esc          cancel: snap back, placement unchanged
 *
 * Dragging is the ONLY thing that sets `manual`.
 */
import { slotAtPoint, type Slot } from '../shared/grid';
import type { GridView } from './grid-view';

const LIFT_PX = 4;
const EDGE_PX = 40;
const EDGE_STEP = 6;
const SURFACE_PAD_TOP = 8;

export interface DragDeps {
  rail: HTMLElement;
  /** The element that scrolls — .rail__scroll. */
  scroller: HTMLElement;
  surface: HTMLElement;
  dropTarget: HTMLElement;
  grid: GridView;
  onCommit: (id: string, slot: Slot, displaced: Array<{ id: string; col: number; row: number }>) => Promise<void>;
}

interface Session {
  id: string;
  root: HTMLElement;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  /** Grab offset from the note's top-left, in px. */
  grabX: number;
  grabY: number;
  lifted: boolean;
  lastClientX: number;
  lastClientY: number;
  target: Slot;
  raf: number | null;
}

export function installDrag(d: DragDeps): { active: () => boolean } {
  let s: Session | null = null;

  const noteFromEvent = (ev: Event): HTMLElement | null => {
    const t = ev.target as HTMLElement | null;
    if (!t) return null;
    if (t.closest('button, textarea, input, .note__edit')) return null;
    return t.closest('.note') as HTMLElement | null;
  };

  const surfaceOrigin = () => {
    const r = d.surface.getBoundingClientRect();
    return { x: r.left + d.grid.metrics.gutter, y: r.top + SURFACE_PAD_TOP, left: r.left, top: r.top };
  };

  const place = (root: HTMLElement, x: number, y: number) => {
    root.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const resolveTarget = (): Slot => {
    if (!s) return { col: 0, row: 0 };
    const o = surfaceOrigin();
    const { cols, noteSize } = d.grid.metrics;
    // The dragged note's centre, in surface coordinates (slotAtPoint subtracts GUTTER + size/2 itself).
    const noteLeft = s.lastClientX - s.grabX;
    const noteTop = s.lastClientY - s.grabY;
    const cx = noteLeft + noteSize / 2 - o.left;
    const cy = noteTop + noteSize / 2 - o.top - SURFACE_PAD_TOP;
    return slotAtPoint(cx, cy, cols, noteSize, 0);
  };

  const frame = () => {
    if (!s || !s.lifted) return;
    // Follow the pointer, in surface-content coordinates.
    const o = surfaceOrigin();
    place(s.root, s.lastClientX - s.grabX - o.x, s.lastClientY - s.grabY - o.y);

    // Edge auto-scroll.
    const rr = d.scroller.getBoundingClientRect();
    if (s.lastClientY < rr.top + EDGE_PX && d.scroller.scrollTop > 0) d.scroller.scrollTop -= EDGE_STEP;
    else if (s.lastClientY > rr.bottom - EDGE_PX) d.scroller.scrollTop += EDGE_STEP;

    const t = resolveTarget();
    if (t.col !== s.target.col || t.row !== s.target.row) {
      s.target = t;
      d.dropTarget.style.setProperty('--col', String(t.col));
      d.dropTarget.style.setProperty('--row', String(t.row));
      d.grid.setDragOverride({ id: s.id, slot: t });
    }
    s.raf = requestAnimationFrame(frame);
  };

  const lift = () => {
    if (!s) return;
    s.lifted = true;
    s.root.dataset.dragging = '';
    d.rail.dataset.dragging = '';
    const e = d.grid.get(s.id);
    s.target = e ? { ...e.slot } : { col: 0, row: 0 };
    d.dropTarget.style.setProperty('--col', String(s.target.col));
    d.dropTarget.style.setProperty('--row', String(s.target.row));
    d.dropTarget.hidden = false;
    d.grid.setDragOverride({ id: s.id, slot: s.target });
    s.raf = requestAnimationFrame(frame);
  };

  const finish = (commit: boolean) => {
    if (!s) return;
    const sess = s;
    s = null;
    if (sess.raf) cancelAnimationFrame(sess.raf);
    try { sess.root.releasePointerCapture(sess.pointerId); } catch { /* already released */ }
    if (!sess.lifted) return;

    delete sess.root.dataset.dragging;
    delete d.rail.dataset.dragging;
    d.dropTarget.hidden = true;

    if (commit) {
      const target = sess.target;
      const displaced = d.grid.displacedByDrop(sess.id, target);
      // Settle into the cell: hand the transform back to the --col/--row rule.
      sess.root.dataset.settling = '';
      sess.root.style.setProperty('--col', String(target.col));
      sess.root.style.setProperty('--row', String(target.row));
      // Force the current inline transform to be the start value, then release it.
      void sess.root.offsetWidth;
      sess.root.style.transform = '';
      window.setTimeout(() => { delete sess.root.dataset.settling; }, 220);
      d.onCommit(sess.id, target, displaced).finally(() => d.grid.setDragOverride(null));
    } else {
      sess.root.dataset.settling = '';
      void sess.root.offsetWidth;
      sess.root.style.transform = '';
      window.setTimeout(() => { delete sess.root.dataset.settling; }, 220);
      d.grid.setDragOverride(null);
    }
  };

  d.surface.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.button !== 0 || s) return;
    const root = noteFromEvent(ev);
    if (!root || root.dataset.snuffing !== undefined || root.dataset.deleting !== undefined) return;
    const id = root.dataset.id!;
    const rect = root.getBoundingClientRect();
    s = {
      id, root, pointerId: ev.pointerId,
      startClientX: ev.clientX, startClientY: ev.clientY,
      grabX: ev.clientX - rect.left, grabY: ev.clientY - rect.top,
      lifted: false, lastClientX: ev.clientX, lastClientY: ev.clientY,
      target: { col: 0, row: 0 }, raf: null,
    };
    root.setPointerCapture(ev.pointerId);
  });

  d.surface.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!s || ev.pointerId !== s.pointerId) return;
    s.lastClientX = ev.clientX;
    s.lastClientY = ev.clientY;
    if (!s.lifted) {
      if (Math.hypot(ev.clientX - s.startClientX, ev.clientY - s.startClientY) >= LIFT_PX) lift();
    }
  });

  d.surface.addEventListener('pointerup', (ev: PointerEvent) => {
    if (!s || ev.pointerId !== s.pointerId) return;
    finish(true);
  });
  d.surface.addEventListener('pointercancel', (ev: PointerEvent) => {
    if (!s || ev.pointerId !== s.pointerId) return;
    finish(false);
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && s && s.lifted) { ev.preventDefault(); finish(false); }
  }, true);

  return { active: () => !!s && s.lifted };
}
