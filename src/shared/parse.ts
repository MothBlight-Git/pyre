/**
 * Composer grammar + date parser (CLAUDE.md §7, design-handoff §2).
 *
 *   topic / comment [/ due]
 *
 * Split on `/`. Two segments = no due. Three = with a due. More than three:
 * everything up to the last `/` folds into the comment, and the final segment
 * is a due ONLY if it parses as a date, otherwise it stays in the comment.
 * A leading `/` files under UNSORTED. Topic is stored as typed; display
 * uppercases.
 *
 * Shared by the renderer (live chips), the main process and the MCP server
 * (`parse_line`), so all three agree on what a line means.
 */

export interface ParsedLine {
  /** As typed (trimmed). Empty string means UNSORTED. */
  topic: string;
  comment: string;
  /** ISO UTC, or null. */
  due: string | null;
  /** The raw text of the segment that became `due`, for tests/debugging. */
  dueText: string | null;
  /** True when the line has a topic and a non-empty comment. */
  valid: boolean;
  /** How many `/`-separated segments were typed. Drives the empty-chip UI. */
  segments: number;
}

export interface ParseOptions {
  now?: Date;
  /** "17:00" — applied to any parsed date without an explicit time. */
  defaultTime?: string;
}

export const UNSORTED = 'UNSORTED';

export function parseLine(line: string, opts: ParseOptions = {}): ParsedLine {
  const raw = line.replace(/\r?\n/g, ' ');
  const segs = raw.split('/').map((s) => s.trim());
  const n = segs.length;

  const topic = segs[0] ?? '';
  let comment = '';
  let due: string | null = null;
  let dueText: string | null = null;

  if (n === 2) {
    comment = segs[1];
  } else if (n >= 3) {
    const last = segs[n - 1];
    const parsed = last ? parseDue(last, opts) : null;
    if (parsed) {
      due = parsed.toISOString();
      dueText = last;
      comment = segs.slice(1, n - 1).join(' / ');
    } else {
      comment = segs.slice(1).join(' / ').replace(/\s*\/\s*$/, '');
    }
  }

  return {
    topic,
    comment,
    due,
    dueText,
    valid: comment.trim().length > 0,
    segments: n,
  };
}

/** Display form of a topic. Never mutate the stored casing. */
export function displayTopic(topic: string): string {
  const t = topic.trim();
  return (t ? t : UNSORTED).toUpperCase();
}

// ---------------------------------------------------------------- dates

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

interface TimeOfDay { h: number; m: number }

function parseDefaultTime(s: string | undefined): TimeOfDay {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m) return { h: 17, m: 0 };
  const h = Math.min(23, +m[1]), mm = Math.min(59, +m[2]);
  return { h, m: mm };
}

/**
 * Pull a trailing time expression off the end of a date string.
 *   "3pm" · "3:30pm" · "9 am" · "14:30" · "noon" · "midnight"
 * A bare `\d{1,2}` with no am/pm and no colon is NOT a time (it would eat "8/21").
 */
function splitTime(input: string): { rest: string; time: TimeOfDay | null } {
  const s = input.trim();
  const re = /(?:^|\s)(?:at\s+)?(noon|midnight|(\d{1,2})(?::(\d{2}))?\s*(am|pm)|(\d{1,2}):(\d{2}))\s*$/i;
  const m = re.exec(s);
  if (!m) return { rest: s, time: null };
  let time: TimeOfDay;
  if (m[1].toLowerCase() === 'noon') time = { h: 12, m: 0 };
  else if (m[1].toLowerCase() === 'midnight') time = { h: 0, m: 0 };
  else if (m[4]) {
    let h = +m[2] % 12;
    if (m[4].toLowerCase() === 'pm') h += 12;
    time = { h, m: m[3] ? +m[3] : 0 };
  } else {
    time = { h: Math.min(23, +m[5]), m: Math.min(59, +m[6]) };
  }
  const rest = s.slice(0, m.index).trim();
  return { rest, time };
}

function atTime(d: Date, t: TimeOfDay): Date {
  const out = new Date(d);
  out.setHours(t.h, t.m, 0, 0);
  return out;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * Parse a due expression to a Date, or null if it isn't one.
 * Priority order per spec: today/tonight · tomorrow/tmrw · weekday · 3d/2w/4h ·
 * 8/21, 8-21 · 2026-08-21 · any of those + a time.
 */
export function parseDue(text: string, opts: ParseOptions = {}): Date | null {
  const now = opts.now ?? new Date();
  const def = parseDefaultTime(opts.defaultTime);
  let s = text.trim().toLowerCase();
  if (!s) return null;

  // Filler words that people type without thinking.
  s = s.replace(/^(?:by|on|due|at|next)\s+/, '').trim();
  if (!s) return null;

  // Full ISO datetime → take it literally.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/i.test(s)) {
    const d = new Date(text.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const { rest, time } = splitTime(s);
  const tod = time ?? def;

  // Just a time: today at that time, or tomorrow if already past.
  if (!rest && time) {
    let d = atTime(now, time);
    if (d.getTime() <= now.getTime()) d = atTime(new Date(now.getTime() + 86400e3), time);
    return d;
  }
  if (!rest) return null;

  // today / tonight
  if (rest === 'today') return atTime(now, tod);
  if (rest === 'tonight') return atTime(now, time ?? { h: 21, m: 0 });
  if (rest === 'now') return new Date(now);

  // tomorrow / tmrw / tmr
  if (rest === 'tomorrow' || rest === 'tmrw' || rest === 'tmr') {
    return atTime(new Date(now.getTime() + 86400e3), tod);
  }

  // weekday → next occurrence (today counts if the time is still ahead)
  if (rest in WEEKDAYS) {
    const target = WEEKDAYS[rest];
    let ahead = (target - now.getDay() + 7) % 7;
    if (ahead === 0) {
      const today = atTime(now, tod);
      if (today.getTime() <= now.getTime()) ahead = 7;
    }
    return atTime(new Date(startOfDay(now).getTime() + ahead * 86400e3), tod);
  }

  // relative: 3d · 2w · 4h · 30m · "3 days" · "2 weeks" · "in 4h"
  {
    const m = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)$/.exec(rest);
    if (m) {
      const n = parseFloat(m[1]);
      const u = m[2][0];
      const ms = u === 'm' ? n * 60e3 : u === 'h' ? n * 3600e3 : u === 'd' ? n * 86400e3 : n * 7 * 86400e3;
      const d = new Date(now.getTime() + ms);
      // Day/week offsets land on the default (or given) time; hour/minute offsets are literal.
      if (u === 'd' || u === 'w') return atTime(d, tod);
      if (time) return atTime(d, time);
      return d;
    }
  }

  // ISO date 2026-08-21
  {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(rest);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      if (d.getMonth() !== +m[2] - 1) return null;
      return atTime(d, tod);
    }
  }

  // 8/21 · 8-21 · 8/21/2026 · 8-21-26
  {
    const m = /^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/.exec(rest);
    if (m) {
      const month = +m[1] - 1, day = +m[2];
      if (month < 0 || month > 11 || day < 1 || day > 31) return null;
      let year = now.getFullYear();
      if (m[3]) year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      let d = atTime(new Date(year, month, day), tod);
      if (d.getMonth() !== month) return null; // 2/31
      if (!m[3] && d.getTime() <= now.getTime()) d = atTime(new Date(year + 1, month, day), tod);
      return d;
    }
  }

  // "21 aug" · "aug 21" · "aug 21 2026" · "21 august"
  {
    const m1 = /^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/.exec(rest);
    const m2 = /^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(rest);
    const m = m1 ?? m2;
    if (m) {
      const day = +(m1 ? m1[1] : m2![2]);
      const monName = (m1 ? m1[2] : m2![1]);
      if (monName in MONTHS) {
        const month = MONTHS[monName];
        let year = now.getFullYear();
        if (m[3]) year = +m[3];
        let d = atTime(new Date(year, month, day), tod);
        if (d.getMonth() !== month) return null;
        if (!m[3] && d.getTime() <= now.getTime()) d = atTime(new Date(year + 1, month, day), tod);
        return d;
      }
    }
  }

  return null;
}

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MON_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * The resolved absolute date for the due chip: "FRI 21 AUG 17:00", with the
 * year appended only when it isn't this year. Never the raw string.
 */
export function formatDue(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MON_NAMES[d.getMonth()]}${year} ${hh}:${mm}`;
}

/** Serialise a note back into a composer line for in-place editing. */
export function toLine(note: { topic: string; comment: string; due: string | null }): string {
  const t = note.topic.trim() ? note.topic : '';
  const parts = [t, note.comment];
  if (note.due) {
    const d = new Date(note.due);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
    parts.push(`${y}-${mo}-${da} ${hh}:${mm}`);
  }
  return parts.join(' / ');
}
