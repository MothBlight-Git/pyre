/**
 * PYRE — burn curve. THE single source of truth for urgency.
 *
 * Imported by BOTH the renderer and the MCP server. If `list_notes` ever
 * reports a different burn than the screen shows, an agent and the user are
 * looking at two different products. Do not fork this file.
 *
 * Copy to: src/shared/heat.ts
 */

/** Combustion begins this many minutes before due. Nothing burns before it. */
export const FUSE_MINUTES = 120;

/** Mask front depth at the due moment. Capped so the comment stays readable. */
export const MAX_BURN = 26;

/** Front depth once fully overdue. Never climbs past this. */
export const OVERDUE_BURN = 30;

/** Minutes overdue at which OVERDUE_BURN is reached. */
export const OVERDUE_SATURATE = 1440; // 24h

/** Ease-in exponent. >1 pushes the visible drama into the final half hour. */
export const GAMMA = 1.6;

/** Ambient firelight begins this far out. Warmth only — no paper is consumed. */
export const WARMTH_MINUTES = 1440; // 24h

/** Past this many minutes overdue the fire goes out (phase 9A/9B). */
export const GONE_OUT_MINUTES = 10080; // 7d

/** `B` banks for this long. `Shift+B` banks until end of day. */
export const DEFAULT_BANK_MINUTES = 120;

export type BurnState =
  | 'cold'      // no due date
  | 'warming'   // due set, outside the fuse — ambient warmth only
  | 'due'       // fuse lit, front just breaking
  | 'burning'   // front climbing
  | 'critical'  // final approach
  | 'overdue'   // past due
  | 'gone-out'  // >7d overdue — chroma removed (see design-handoff §9A)
  | 'banked';   // user-damped; --burn frozen

export interface Burn {
  /** Mask front depth, in percent. Feed straight into `--burn`. */
  burn: number;
  /** Ambient firelight 0–1. Feed into `--warmth`. Independent of `burn`. */
  warmth: number;
  state: BurnState;
  /** Negative once overdue. null when the note has no due date. */
  minutesToDue: number | null;
  /** "6h" / "24m" / "-2d" — exactly what the countdown renders. */
  label: string;
}

export function minutesToDue(due: string | null, now: Date = new Date()): number | null {
  if (!due) return null;
  return (new Date(due).getTime() - now.getTime()) / 60000;
}

/**
 * The curve. Verified to pass through the three approved sample renders:
 *   t=60m -> 8.6%   (design "due"      sample = 8%)
 *   t=30m -> 16.4%  (design "burning"  sample = 17%)
 *   t=0   -> 26.0%  (design "overdue"  sample = 26%)
 */
export function burnFor(t: number | null): number {
  if (t === null) return 0;
  if (t > FUSE_MINUTES) return 0;
  if (t > 0) {
    const p = (FUSE_MINUTES - t) / FUSE_MINUTES;
    return MAX_BURN * Math.pow(p, GAMMA);
  }
  const over = Math.min(-t / OVERDUE_SATURATE, 1);
  return MAX_BURN + (OVERDUE_BURN - MAX_BURN) * over;
}

/**
 * Ambient firelight. Deliberately a SECOND driver, ramping over 24h, so that a
 * note due tomorrow does not look identical to one due in three weeks.
 *
 * To make the product strictly binary before the fuse (nothing at all until
 * T-2h), return 0 here. That is a one-line change and the only thing lost is
 * the anticipation band. See CLAUDE.md "Open decisions" #1.
 */
export function warmthFor(t: number | null): number {
  if (t === null) return 0.18;                 // cold notes keep the design's static bottom-edge wash
  if (t > WARMTH_MINUTES) return 0.18;
  if (t <= 0) return 1;
  return 0.18 + 0.82 * (1 - t / WARMTH_MINUTES);
}

export function stateFor(t: number | null, burn: number, bankedUntil?: string | null, now: Date = new Date()): BurnState {
  if (bankedUntil && new Date(bankedUntil).getTime() > now.getTime()) return 'banked';
  if (t === null) return 'cold';
  if (t <= -GONE_OUT_MINUTES) return 'gone-out';
  if (t <= 0) return 'overdue';
  if (burn === 0) return 'warming';
  if (burn < 12) return 'due';
  if (burn < 22) return 'burning';
  return 'critical';
}

export function labelFor(t: number | null): string {
  if (t === null) return '';
  const a = Math.abs(t);
  // "-0m" is a nonsense reading; the first overdue minute renders as "0m".
  const sign = t < 0 && Math.round(a) > 0 ? '-' : '';
  if (a < 60) return `${sign}${Math.round(a)}m`;
  if (a < 1440) return `${sign}${Math.round(a / 60)}h`;
  return `${sign}${Math.round(a / 1440)}d`;
}

export function evaluate(
  note: { due: string | null; bankedUntil?: string | null; bankedAt?: string | null; updated?: string },
  now: Date = new Date()
): Burn {
  const t = minutesToDue(note.due, now);
  const banked = !!note.bankedUntil && new Date(note.bankedUntil).getTime() > now.getTime();
  // Banking freezes the front at the value it held when banking began. `bankedAt`
  // records that instant; older records fall back to `updated`, then to now.
  let burn: number;
  if (banked) {
    // Fallback for records with no start time (hand-edited files): assume the
    // default 2h bank, i.e. banking began DEFAULT_BANK_MINUTES before bankedUntil.
    const began = note.bankedAt ?? note.updated ?? null;
    const frozenAt = began
      ? new Date(began)
      : new Date(new Date(note.bankedUntil!).getTime() - DEFAULT_BANK_MINUTES * 60000);
    // Never let the frozen value exceed what the live curve would show —
    // a stale bankedAt in the future must not advance the fire.
    burn = Math.min(burnFor(minutesToDue(note.due, frozenAt)), burnFor(t));
  } else {
    burn = burnFor(t);
  }
  return {
    burn,
    warmth: warmthFor(t),
    state: stateFor(t, burn, note.bankedUntil, now),
    minutesToDue: t,
    label: labelFor(t),
  };
}

/**
 * Tick cadence. The fuse is only 2h long, so a flat 30s tick is too coarse in
 * the final minutes — the front would visibly step. Returns ms until next tick.
 */
export function nextTickMs(t: number | null): number {
  if (t === null || t > FUSE_MINUTES) return 60_000;
  if (t > 20) return 30_000;
  if (t > 5) return 10_000;
  if (t > 0) return 5_000;
  return 60_000;
}
