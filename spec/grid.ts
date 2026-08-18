/**
 * PYRE — grid placement.
 *
 * The rule, in one sentence: hot notes claim the top-left, but a note the user
 * has dragged holds its cell and the hot notes flow around it.
 *
 * Copy to: src/shared/grid.ts
 */

import { burnFor, minutesToDue } from './heat';

export interface Slot { col: number; row: number; }

export type Placement =
  | { mode: 'auto' }
  | { mode: 'manual'; col: number; row: number; pinnedAt: string };

export interface PlaceableNote {
  id: string;
  due: string | null;
  created: string;
  bankedUntil?: string | null;
  placement: Placement;
}

const key = (s: Slot) => `${s.col},${s.row}`;

/**
 * Scan forward in reading order (left→right, top→bottom) from `from`,
 * returning the first slot not present in `taken`.
 */
function nextFree(taken: Set<string>, cols: number, from: Slot): Slot {
  let { col, row } = from;
  for (;;) {
    if (!taken.has(key({ col, row }))) return { col, row };
    col += 1;
    if (col >= cols) { col = 0; row += 1; }
  }
}

/**
 * Resolve every note to a concrete cell.
 *
 * Order of operations is load-bearing:
 *   1. Manual notes claim first, oldest pin wins a contested cell.
 *   2. Auto notes fill what is left, hottest first, in reading order.
 *
 * This is what makes "unless intentionally moved away" true: an auto note that
 * is fully on fire will never evict a manually placed cold note. The user's
 * hand beats the sort.
 *
 * @returns id → slot, plus any manual notes whose stored slot had to change
 *          (collision or column-count shrink). Persist those corrections.
 */
export function layout(
  notes: PlaceableNote[],
  cols: number,
  now: Date = new Date()
): { slots: Map<string, Slot>; corrections: Map<string, Slot> } {
  const slots = new Map<string, Slot>();
  const corrections = new Map<string, Slot>();
  const taken = new Set<string>();

  const manual = notes
    .filter((n): n is PlaceableNote & { placement: Extract<Placement, { mode: 'manual' }> } =>
      n.placement.mode === 'manual')
    .sort((a, b) => a.placement.pinnedAt.localeCompare(b.placement.pinnedAt));

  for (const n of manual) {
    // Clamp into range — the rail is user-resizable, so cols can shrink under a pin.
    const wanted: Slot = {
      col: Math.max(0, Math.min(cols - 1, n.placement.col)),
      row: Math.max(0, n.placement.row),
    };
    const got = taken.has(key(wanted)) ? nextFree(taken, cols, wanted) : wanted;
    if (got.col !== n.placement.col || got.row !== n.placement.row) corrections.set(n.id, got);
    taken.add(key(got));
    slots.set(n.id, got);
  }

  const auto = notes
    .filter((n) => n.placement.mode === 'auto')
    .sort((a, b) => {
      const ba = burnFor(minutesToDue(a.due, now));
      const bb = burnFor(minutesToDue(b.due, now));
      if (bb !== ba) return bb - ba;                       // hottest first
      if (!!b.due !== !!a.due) return a.due ? -1 : 1;      // dated above undated
      return b.created.localeCompare(a.created);           // newest first
    });

  let cursor: Slot = { col: 0, row: 0 };
  for (const n of auto) {
    const got = nextFree(taken, cols, cursor);
    taken.add(key(got));
    slots.set(n.id, got);
    cursor = got;
  }

  return { slots, corrections };
}

export const GUTTER = 16;
export const GAP = 20;          // keeps bloom + tongues off neighbours — do not shrink
export const MIN_NOTE = 140;
export const MAX_NOTE = 200;

/**
 * Note size is DERIVED from rail width, not fixed.
 *
 * The design files quote "176px at a 396px rail" and "160px at 340px", but
 * neither fits two columns at 16px gutters and a 20px gap — 176px needs 404px
 * and 160px needs 372px. Rather than pick a magic width, the grid solves for
 * the largest square that fits. The burn system is entirely percentage-based,
 * so it rescales for free; only the fixed-px type stops looking right below
 * ~140px, which is where MIN_NOTE comes from.
 *
 *   280px rail -> 1 col @ 200px (row centred, slack split evenly)
 *   340px rail -> 2 col @ 144px
 *   396px rail -> 2 col @ 172px
 *   420px rail -> 2 col @ 184px
 */
export function gridMetrics(railWidth: number): { cols: number; noteSize: number } {
  for (let cols = 3; cols >= 2; cols--) {
    const size = Math.floor((railWidth - GUTTER * 2 - (cols - 1) * GAP) / cols);
    if (size >= MIN_NOTE && size <= MAX_NOTE) return { cols, noteSize: size };
  }
  const size = railWidth - GUTTER * 2;
  return { cols: 1, noteSize: Math.min(MAX_NOTE, Math.max(MIN_NOTE, size)) };
}

/**
 * Pointer position → target cell, snapping to the NEAREST cell centre rather
 * than the cell the pointer is literally inside. A pointer resting in the 20px
 * gap must resolve to one side or the other, never to "no cell".
 */
export function slotAtPoint(
  x: number, y: number,
  cols: number, noteSize: number, scrollTop: number
): Slot {
  const pitch = noteSize + GAP;
  const col = Math.max(0, Math.min(cols - 1, Math.round((x - GUTTER - noteSize / 2) / pitch)));
  const row = Math.max(0, Math.round((y + scrollTop - noteSize / 2) / pitch));
  return { col, row };
}

/**
 * Notes that are on fire but sitting below the fold because the user pinned
 * them there. Drives the flare pip (see CLAUDE.md §6.4) — we never move a
 * pinned note, but we never let a fire hide either.
 */
export function hiddenFires(
  notes: PlaceableNote[],
  slots: Map<string, Slot>,
  visibleRows: number,
  now: Date = new Date()
): string[] {
  return notes
    .filter((n) => {
      const s = slots.get(n.id);
      if (!s || s.row < visibleRows) return false;
      return burnFor(minutesToDue(n.due, now)) > 0;
    })
    .map((n) => n.id);
}
