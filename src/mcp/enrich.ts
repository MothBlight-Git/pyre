/**
 * Shared note enrichment for every agent surface: the stdio MCP server, the
 * local HTTP MCP endpoint, and the in-app assistant (src/main/agent.ts).
 *
 * All three must report the same burn as the screen — that is the whole point
 * of shared/heat.ts. Keeping the enrichment here means adding a field shows up
 * everywhere at once instead of drifting between surfaces.
 */
import type { Store } from '../main/store';
import { evaluate } from '../shared/heat';
import { layout, gridMetrics, type Slot } from '../shared/grid';
import { parseLine, formatDue } from '../shared/parse';
import type { Note } from '../shared/types';

export function enrichNote(n: Note, now: Date, slots: Map<string, Slot>) {
  const b = evaluate(n, now);
  return {
    ...n,
    burn: Math.round(b.burn * 100) / 100,
    warmth: Math.round(b.warmth * 1000) / 1000,
    state: b.state,
    minutesToDue: b.minutesToDue === null ? null : Math.round(b.minutesToDue),
    label: b.label,
    dueLocal: n.due ? formatDue(n.due, now) : null,
    slot: slots.get(n.id) ?? null,
  };
}

export function layoutFor(store: Store, notes: Note[], now: Date) {
  const cols = gridMetrics(store.settings().railWidth).cols;
  const live = notes.filter((n) => !n.done);
  return { cols, ...layout(live, cols, now) };
}

/**
 * ISO passthrough or any composer date form ("fri 9am", "3d", "tomorrow").
 * Returns null for null/empty, and `false` when the text is not a date at all —
 * callers must distinguish "no deadline" from "I could not read that".
 */
export function resolveDue(store: Store, input: string | null | undefined): string | null | false {
  if (input === null || input === undefined || input.trim() === '') return null;
  const s = input.trim();
  const direct = Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(direct)) return new Date(direct).toISOString();
  const p = parseLine(`x / y / ${s}`, { defaultTime: store.settings().defaultDueTime });
  if (p.due) return p.due;
  return Number.isNaN(direct) ? false : new Date(direct).toISOString();
}
