/**
 * PYRE — spec tests. Vitest (`npx vitest run`) or `node --test` with a TS loader.
 * These encode the behaviour, not the implementation. If a refactor breaks one
 * of these, the refactor is wrong.
 *
 * Copy to: test/pyre.test.ts
 */

import { describe, it, expect } from 'vitest';
import { burnFor, warmthFor, stateFor, labelFor, evaluate, nextTickMs, FUSE_MINUTES } from '../src/shared/heat';
import { layout, gridMetrics, slotAtPoint, hiddenFires, PlaceableNote } from '../src/shared/grid';

const NOW = new Date('2026-08-17T12:00:00Z');
const at = (m: number) => new Date(NOW.getTime() + m * 60000).toISOString();
const mk = (id: string, dueMin: number | null, placement: any, created = '2026-08-01T00:00:00Z'): PlaceableNote =>
  ({ id, due: dueMin === null ? null : at(dueMin), created, placement });

describe('burn curve — nothing burns before T-2h', () => {
  it('is exactly zero outside the fuse', () => {
    expect(burnFor(null)).toBe(0);
    expect(burnFor(10080)).toBe(0);          // a week out
    expect(burnFor(FUSE_MINUTES + 1)).toBe(0);
    expect(burnFor(FUSE_MINUTES)).toBe(0);
  });

  it('breaks the front immediately inside the fuse', () => {
    expect(burnFor(119)).toBeGreaterThan(0);
  });

  it('passes through the three approved sample renders', () => {
    expect(burnFor(60)).toBeCloseTo(8.6, 1);   // design "due"     sample = 8%
    expect(burnFor(30)).toBeCloseTo(16.4, 1);  // design "burning" sample = 17%
    expect(burnFor(0)).toBeCloseTo(26.0, 1);   // design "overdue" sample = 26%
  });

  it('reaches max at due and never exceeds the readability cap', () => {
    expect(burnFor(0)).toBe(26);
    expect(burnFor(-1440)).toBe(30);
    expect(burnFor(-100000)).toBe(30);          // still 30 — the comment must survive
  });

  it('is monotonic across the whole fuse', () => {
    for (let t = 120; t > 0; t--) expect(burnFor(t - 1)).toBeGreaterThan(burnFor(t) - 1e-9);
  });
});

describe('states and labels', () => {
  it('names each band', () => {
    expect(stateFor(null, 0)).toBe('cold');
    expect(stateFor(300, burnFor(300))).toBe('warming');
    expect(stateFor(60, burnFor(60))).toBe('due');
    expect(stateFor(30, burnFor(30))).toBe('burning');
    expect(stateFor(5, burnFor(5))).toBe('critical');
    expect(stateFor(-60, burnFor(-60))).toBe('overdue');
    expect(stateFor(-20000, burnFor(-20000))).toBe('gone-out');
  });

  it('renders countdowns the way the subject row expects', () => {
    expect(labelFor(45)).toBe('45m');
    expect(labelFor(360)).toBe('6h');
    expect(labelFor(-2880)).toBe('-2d');
  });

  it('freezes the front while banked but keeps the countdown honest', () => {
    const banked = evaluate({ due: at(20), bankedUntil: at(60) }, NOW);
    expect(banked.state).toBe('banked');
    expect(banked.burn).toBeLessThan(burnFor(20));  // damped, not advanced
    expect(banked.label).toBe('20m');               // deadline still told truthfully
  });

  it('ticks faster as the deadline closes', () => {
    expect(nextTickMs(300)).toBe(60_000);
    expect(nextTickMs(60)).toBe(30_000);
    expect(nextTickMs(10)).toBe(10_000);
    expect(nextTickMs(2)).toBe(5_000);
  });

  it('gives a 24h ambient ramp that never consumes paper', () => {
    expect(warmthFor(2000)).toBeCloseTo(0.18, 2);
    expect(warmthFor(720)).toBeGreaterThan(warmthFor(1400));
    expect(burnFor(720)).toBe(0);                   // warm, but nothing burning
  });
});

describe('grid — hot notes claim top-left, the user overrides', () => {
  it('puts the hottest auto note at (0,0)', () => {
    const notes = [
      mk('cold1', null, { mode: 'auto' }, '2026-08-10T00:00:00Z'),
      mk('hot', 30, { mode: 'auto' }, '2026-08-02T00:00:00Z'),
      mk('warm', 600, { mode: 'auto' }, '2026-08-05T00:00:00Z'),
    ];
    const { slots } = layout(notes, 2, NOW);
    expect(slots.get('hot')).toEqual({ col: 0, row: 0 });
    expect(slots.get('warm')).toEqual({ col: 1, row: 0 });
    expect(slots.get('cold1')!.row).toBe(1);
  });

  it('never lets a burning note evict a note the user placed', () => {
    const notes = [
      mk('pinnedCold', null, { mode: 'manual', col: 0, row: 0, pinnedAt: '2026-08-15T00:00:00Z' }),
      mk('onFire', 5, { mode: 'auto' }),
    ];
    const { slots } = layout(notes, 2, NOW);
    expect(slots.get('pinnedCold')).toEqual({ col: 0, row: 0 });
    expect(slots.get('onFire')).toEqual({ col: 1, row: 0 });
  });

  it('gives a contested cell to the older pin and reports the correction', () => {
    const notes = [
      mk('early', null, { mode: 'manual', col: 1, row: 2, pinnedAt: '2026-08-01T00:00:00Z' }),
      mk('late', null, { mode: 'manual', col: 1, row: 2, pinnedAt: '2026-08-16T00:00:00Z' }),
    ];
    const { slots, corrections } = layout(notes, 2, NOW);
    expect(slots.get('early')).toEqual({ col: 1, row: 2 });
    expect(corrections.has('late')).toBe(true);
    expect(slots.get('late')).toEqual({ col: 0, row: 3 });
  });

  it('clamps a pin that falls outside a narrowed rail', () => {
    const notes = [mk('wide', null, { mode: 'manual', col: 2, row: 0, pinnedAt: '2026-08-01T00:00:00Z' })];
    const { slots, corrections } = layout(notes, 2, NOW);
    expect(slots.get('wide')!.col).toBe(1);
    expect(corrections.has('wide')).toBe(true);
  });

  it('leaves no holes and no collisions', () => {
    const notes = [
      mk('p', null, { mode: 'manual', col: 0, row: 1, pinnedAt: '2026-08-01T00:00:00Z' }),
      mk('a', 10, { mode: 'auto' }), mk('b', 20, { mode: 'auto' }),
      mk('c', 30, { mode: 'auto' }), mk('d', 40, { mode: 'auto' }),
    ];
    const { slots } = layout(notes, 2, NOW);
    const used = [...slots.values()].map((s) => `${s.col},${s.row}`);
    expect(new Set(used).size).toBe(5);
    expect(used.sort().join(' ')).toBe('0,0 0,1 0,2 1,0 1,1');
  });

  it('raises a flare pip for a pinned fire below the fold', () => {
    const notes = [mk('buried', 15, { mode: 'manual', col: 0, row: 9, pinnedAt: '2026-08-01T00:00:00Z' })];
    const { slots } = layout(notes, 2, NOW);
    expect(hiddenFires(notes, slots, 4, NOW)).toContain('buried');
  });
});

describe('grid geometry', () => {
  it('derives note size from rail width', () => {
    expect(gridMetrics(396)).toEqual({ cols: 2, noteSize: 172 });
    expect(gridMetrics(340)).toEqual({ cols: 2, noteSize: 144 });
    expect(gridMetrics(420)).toEqual({ cols: 2, noteSize: 184 });
    expect(gridMetrics(280)).toEqual({ cols: 1, noteSize: 200 });
  });

  it('snaps a pointer in the gap to the nearest cell', () => {
    expect(slotAtPoint(210, 400, 2, 176, 0)).toEqual({ col: 1, row: 2 });
    expect(slotAtPoint(60, 30, 2, 176, 0)).toEqual({ col: 0, row: 0 });
  });
});
