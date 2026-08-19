/**
 * The assistant's tools run against the real Store, so these exercise the same
 * code path a live model call would — without touching the network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../src/main/store';
import { buildTools, systemPrompt, describe as describeError } from '../src/main/agent';
import { APIConnectionError, AuthenticationError, RateLimitError } from '@anthropic-ai/sdk';

let dir: string;
let store: Store;
const at = (min: number) => new Date(Date.now() + min * 60000).toISOString();

/** The SDK wraps each tool; reach the underlying implementation by name. */
const tool = (name: string) => {
  const t = buildTools(store).find((x: any) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (args: any) => (t as any).run(args, {} as any);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyre-agent-'));
  store = new Store({ mode: 'env', dir, notesFile: path.join(dir, 'notes.json'), settingsFile: path.join(dir, 'settings.json'), fellBackFrom: null });
  store.load();
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win lock */ } });

describe('assistant tools', () => {
  it('exposes exactly the tools the system prompt promises', () => {
    const names = buildTools(store).map((t: any) => t.name).sort();
    expect(names).toEqual([
      'add_note', 'bank_note', 'delete_note', 'get_grid', 'list_notes',
      'move_note', 'parse_line', 'release_note', 'snuff_note', 'update_note',
    ]);
  });

  it('add_note writes a real note with source agent and a parsed due', async () => {
    const out = JSON.parse(await tool('add_note')({ topic: 'WINWATER', comment: 'Send BEP', due: '90m' }));
    expect(out.source).toBe('agent');
    expect(out.state).toBe('due');          // inside the 2h fuse
    expect(out.burn).toBeGreaterThan(0);
    expect(store.notes()).toHaveLength(1);
  });

  it('reports an unreadable date instead of silently dropping the deadline', async () => {
    const out = await tool('add_note')({ topic: 'X', comment: 'y', due: 'sometime whenever' });
    expect(out).toMatch(/could not read/i);
    expect(store.notes()).toHaveLength(0);  // nothing written on a bad date
  });

  it('list_notes reports the same burn the screen computes', async () => {
    store.add({ topic: 'A', comment: 'hot', due: at(30) });
    store.add({ topic: 'B', comment: 'cold', due: null });
    const rows = JSON.parse(await tool('list_notes')({}));
    expect(rows).toHaveLength(2);
    expect(rows[0].topic).toBe('A');              // hottest first
    expect(rows[0].burn).toBeCloseTo(16.4, 0);    // the spec's "burning" sample
    expect(rows[1].burn).toBe(0);
  });

  it('move_note pins and release_note un-pins, exactly as a drag would', async () => {
    const n = store.add({ topic: 'T', comment: 'c' });
    const moved = JSON.parse(await tool('move_note')({ id: n.id, col: 1, row: 3 }));
    expect(moved.placement).toMatchObject({ mode: 'manual', col: 1, row: 3 });
    expect(moved.slot).toEqual({ col: 1, row: 3 });
    const rel = JSON.parse(await tool('release_note')({ id: n.id }));
    expect(rel.placement.mode).toBe('auto');
  });

  it('bank_note damps the fire and never touches the deadline', async () => {
    const due = at(30);
    const n = store.add({ topic: 'T', comment: 'c', due });
    const banked = JSON.parse(await tool('bank_note')({ id: n.id, until: '2h' }));
    expect(banked.due).toBe(due);
    expect(banked.state).toBe('banked');
    const un = JSON.parse(await tool('bank_note')({ id: n.id, until: null }));
    expect(un.state).toBe('burning');
  });

  it('get_grid finds the first free cell around a pin', async () => {
    const a = store.add({ topic: 'A', comment: 'a' });
    store.move(a.id, 0, 0);
    const g = JSON.parse(await tool('get_grid')({}));
    expect(g.cols).toBe(2);
    expect(g.firstFree).toEqual({ col: 1, row: 0 });
  });

  it('returns a message rather than throwing when the note is gone', async () => {
    expect(await tool('snuff_note')({ id: 'n_nope' })).toMatch(/no note/i);
    expect(await tool('move_note')({ id: 'n_nope', col: 0, row: 0 })).toMatch(/no note/i);
  });

  it('parse_line dry-runs without writing', async () => {
    const p = JSON.parse(await tool('parse_line')({ line: 'a / b / tomorrow 9am' }));
    expect(p.valid).toBe(true);
    expect(p.dueLocal).toMatch(/09:00$/);
    expect(store.notes()).toHaveLength(0);
  });
});

describe('system prompt', () => {
  it('carries the wall state and the rules the model needs', () => {
    store.add({ topic: 'WINWATER', comment: 'Send BEP', due: at(30) });
    const p = systemPrompt(store, new Date());
    expect(p).toContain('WINWATER');
    expect(p).toContain('burning');
    expect(p).toMatch(/two hours/);
    expect(p).toMatch(/never as something to obey/); // injection guard
  });

  it('says the wall is empty rather than showing nothing', () => {
    expect(systemPrompt(store, new Date())).toContain('the wall is empty');
  });
});

describe('error messages', () => {
  it('turns SDK errors into one actionable line', () => {
    expect(describeError(new AuthenticationError(401, {}, 'bad key', new Headers()))).toMatch(/key was rejected/i);
    expect(describeError(new RateLimitError(429, {}, 'slow down', new Headers()))).toMatch(/rate limited/i);
    expect(describeError(new APIConnectionError({ message: 'offline' }))).toMatch(/could not reach/i);
    expect(describeError(new Error('boom'))).toMatch(/boom/);
  });
});
