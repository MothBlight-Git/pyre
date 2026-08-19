import { describe, it, expect } from 'vitest';
import { parseLine, parseDue, parseCommand, parseMessage, formatDue, toLine } from '../src/shared/parse';

// Monday 2026-08-17 10:00 local
const NOW = new Date(2026, 7, 17, 10, 0, 0, 0);
const opts = { now: NOW, defaultTime: '17:00' };
const local = (y: number, mo: number, d: number, h = 17, m = 0) => new Date(y, mo - 1, d, h, m).toISOString();

describe('grammar', () => {
  it('two segments = topic + comment, no due', () => {
    const p = parseLine('winwater / send bep', opts);
    expect(p).toMatchObject({ topic: 'winwater', comment: 'send bep', due: null, valid: true, segments: 2 });
  });
  it('three segments with a parsable due', () => {
    const p = parseLine('winwater / send bep / fri', opts);
    expect(p.due).toBe(local(2026, 8, 21));
    expect(p.comment).toBe('send bep');
  });
  it('third segment that is not a date is absorbed by the comment, no due', () => {
    const p = parseLine('a / b / c', opts);
    expect(p.due).toBeNull();
    expect(p.comment).toBe('b / c');
  });
  it('more than three: middle folds into comment, last is due only if it parses', () => {
    expect(parseLine('a / b / c / tomorrow', opts)).toMatchObject({ comment: 'b / c', due: local(2026, 8, 18) });
    expect(parseLine('a / b / c / d', opts)).toMatchObject({ comment: 'b / c / d', due: null });
  });
  it('leading slash files under UNSORTED (empty topic)', () => {
    const p = parseLine('/ just a thought', opts);
    expect(p.topic).toBe('');
    expect(p.comment).toBe('just a thought');
    expect(p.valid).toBe(true);
  });
  it('one segment is not valid yet', () => {
    expect(parseLine('winwater', opts).valid).toBe(false);
    expect(parseLine('winwater /', opts).valid).toBe(false);
  });
  it('preserves topic casing', () => {
    expect(parseLine('WinWater / x', opts).topic).toBe('WinWater');
  });
});

describe('due parser', () => {
  const at = (s: string) => parseDue(s, opts)?.toISOString() ?? null;

  it('today / tonight', () => {
    expect(at('today')).toBe(local(2026, 8, 17, 17));
    expect(at('tonight')).toBe(local(2026, 8, 17, 21));
    expect(at('today 3pm')).toBe(local(2026, 8, 17, 15));
  });
  it('tomorrow / tmrw', () => {
    expect(at('tomorrow')).toBe(local(2026, 8, 18));
    expect(at('tmrw 9am')).toBe(local(2026, 8, 18, 9));
  });
  it('weekday = next occurrence; today counts if the time is still ahead', () => {
    expect(at('fri')).toBe(local(2026, 8, 21));
    expect(at('friday 9am')).toBe(local(2026, 8, 21, 9));
    expect(at('mon')).toBe(local(2026, 8, 17)); // it is Monday 10:00, 17:00 still ahead
    expect(at('mon 9am')).toBe(local(2026, 8, 24, 9)); // 09:00 already passed → next Monday
    expect(at('sun')).toBe(local(2026, 8, 23));
  });
  it('relative offsets', () => {
    expect(at('4h')).toBe(new Date(NOW.getTime() + 4 * 3600e3).toISOString());
    expect(at('30m')).toBe(new Date(NOW.getTime() + 30 * 60e3).toISOString());
    expect(at('3d')).toBe(local(2026, 8, 20));
    expect(at('2w')).toBe(local(2026, 8, 31));
    expect(at('in 2 days')).toBe(local(2026, 8, 19));
  });
  it('month/day this year, or next year if past', () => {
    expect(at('8/21')).toBe(local(2026, 8, 21));
    expect(at('8-21')).toBe(local(2026, 8, 21));
    expect(at('8/21 3pm')).toBe(local(2026, 8, 21, 15));
    expect(at('1/5')).toBe(local(2027, 1, 5));
    expect(at('2/31')).toBeNull();
  });
  it('ISO date', () => {
    expect(at('2026-08-21')).toBe(local(2026, 8, 21));
    expect(at('2026-08-21 09:30')).toBe(local(2026, 8, 21, 9, 30));
  });
  it('bare time = today, or tomorrow if past', () => {
    expect(at('3pm')).toBe(local(2026, 8, 17, 15));
    expect(at('9am')).toBe(local(2026, 8, 18, 9));
  });
  it('rejects prose', () => {
    expect(at('call powell')).toBeNull();
    expect(at('c')).toBeNull();
    expect(at('')).toBeNull();
    expect(at('8')).toBeNull();
  });
});

describe('formatting', () => {
  it('shows the resolved absolute date, never the raw string', () => {
    expect(formatDue(local(2026, 8, 21), NOW)).toBe('FRI 21 AUG 17:00');
    expect(formatDue(local(2027, 1, 5, 9), NOW)).toBe('TUE 5 JAN 2027 09:00');
  });
  it('round-trips a note through toLine → parseLine', () => {
    const line = toLine({ topic: 'WINWATER', comment: 'Send BEP', due: local(2026, 8, 21, 9, 30) });
    const p = parseLine(line, opts);
    expect(p.topic).toBe('WINWATER');
    expect(p.comment).toBe('Send BEP');
    expect(p.due).toBe(local(2026, 8, 21, 9, 30));
  });
});

describe('bar commands', () => {
  it('recognises quit and exit, case-insensitively', () => {
    expect(parseCommand('quit')?.kind).toBe('quit');
    expect(parseCommand('  EXIT  ')?.kind).toBe('quit');
    expect(parseCommand('quit')?.label).toBe('QUIT PYRE');
  });
  it('never fires when the line contains a slash — that is always a note', () => {
    expect(parseCommand('/quit')).toBeNull();
    expect(parseCommand('quit / do the thing')).toBeNull();
    expect(parseLine('/ quit', opts)).toMatchObject({ topic: '', comment: 'quit', valid: true });
  });
  it('leaves ordinary words alone', () => {
    expect(parseCommand('quitting')).toBeNull();
    expect(parseCommand('winwater')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

describe('talk lane grammar', () => {
  it('treats a leading > as a message to the agent', () => {
    expect(parseMessage('> move winwater to friday')).toBe('move winwater to friday');
    expect(parseMessage('  >   spaced  ')).toBe('spaced');
  });
  it('lets a message contain slashes without becoming a note', () => {
    expect(parseMessage('> reschedule winwater / powell / friday')).toBe('reschedule winwater / powell / friday');
  });
  it('is not a message without the marker, and not empty', () => {
    expect(parseMessage('winwater / send bep')).toBeNull();
    expect(parseMessage('>')).toBeNull();
    expect(parseMessage('>   ')).toBeNull();
    expect(parseMessage('a > b')).toBeNull();
  });
  it('outranks commands, so "> quit" talks rather than closing the app', () => {
    expect(parseCommand('> quit')).toBeNull();
    expect(parseMessage('> quit')).toBe('quit');
  });
});

describe('dates that contain the separator', () => {
  // The line is split on "/" before the date is read, so a slashed date lands
  // across several segments. Regression: these silently became comments.
  it('reads a slashed date as the due, not as comment text', () => {
    expect(parseLine('test / text / 8/27', opts)).toMatchObject({ comment: 'text', due: local(2026, 8, 27) });
    expect(parseLine('winwater / send bep / 8/21', opts)).toMatchObject({ comment: 'send bep', due: local(2026, 8, 21) });
    expect(parseLine('a / b / 8/21/2026', opts)).toMatchObject({ comment: 'b', due: local(2026, 8, 21) });
    expect(parseLine('a / b / 8/21 3pm', opts)).toMatchObject({ comment: 'b', due: local(2026, 8, 21, 15) });
  });
  it('leaves a slashed non-date in the comment', () => {
    expect(parseLine('recipe / 3/4 cup flour', opts)).toMatchObject({ comment: '3 / 4 cup flour', due: null });
    expect(parseLine('a / ratio 3/4 / and more', opts).due).toBeNull();
    expect(parseLine('a / b / c/d', opts)).toMatchObject({ due: null });
  });
  it('still prefers the shortest tail that parses', () => {
    // "fri" alone is a date; the "/" before it must not be swallowed.
    expect(parseLine('a / b / c / fri', opts)).toMatchObject({ comment: 'b / c', due: local(2026, 8, 21) });
  });
  it('accepts a month name with or without a space', () => {
    expect(parseDue('aug27', opts)?.toISOString()).toBe(local(2026, 8, 27));
    expect(parseDue('27aug', opts)?.toISOString()).toBe(local(2026, 8, 27));
    expect(parseDue('aug 27', opts)?.toISOString()).toBe(local(2026, 8, 27));
    expect(parseDue('august', opts)).toBeNull();  // a bare month is not a date
  });
});
