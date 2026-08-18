/**
 * Ember particles. 2–3px dots spawned on the burn line (`bottom: calc(var(--burn) + 4%)`
 * comes from burn-system.css), escaping the note bounds. Cap 10 across the whole
 * rail, hottest notes first. Per-state counts and timings from the design doc:
 *   due 1 · burning 2 · critical 2 · overdue 3
 *   emberA 4.4–5.2s · emberB 5.4–6.2s (delay 1.1–1.8s) · emberC 6.2s (delay 2.6s)
 * Embers are only re-created when a note's count changes, so the animations
 * don't restart on every tick.
 */
import type { BurnState } from '../shared/heat';
import type { NoteRefs } from './note';

export const EMBER_CAP = 10;

const COUNT: Partial<Record<BurnState, number>> = { due: 1, burning: 2, critical: 2, overdue: 3 };

const VARIANTS = [
  { name: 'emberA', dur: [4.4, 5.2], delay: [0, 0.4] },
  { name: 'emberB', dur: [5.4, 6.2], delay: [1.1, 1.8] },
  { name: 'emberC', dur: [6.2, 6.6], delay: [2.6, 3.0] },
];

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function spawn(host: HTMLElement, count: number): void {
  host.replaceChildren();
  for (let i = 0; i < count; i++) {
    const v = VARIANTS[i % VARIANTS.length];
    const e = document.createElement('div');
    e.className = 'ember';
    const size = Math.random() < 0.5 ? 2 : 3;
    e.style.cssText =
      `left:${rand(14, 78).toFixed(1)}%;width:${size}px;height:${size}px;` +
      `background:${i % 2 ? '#FFFBEE' : '#FFE3A8'};` +
      `animation:${v.name} ${rand(v.dur[0], v.dur[1]).toFixed(2)}s linear ${rand(v.delay[0], v.delay[1]).toFixed(2)}s infinite;`;
    host.appendChild(e);
  }
}

/**
 * @param ordered note refs, hottest first (the caller already sorts by burn).
 */
export function syncEmbers(ordered: Array<{ refs: NoteRefs; state: BurnState }>): void {
  let budget = EMBER_CAP;
  for (const { refs, state } of ordered) {
    let want = COUNT[state] ?? 0;
    if (want > budget) want = budget;
    budget -= want;
    const have = refs.emberHost.childElementCount;
    if (have !== want) spawn(refs.emberHost, want);
  }
}
