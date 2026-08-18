import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../src/main/store';
import { migrate } from '../src/shared/migrate';
import { resolvePaths, probeWritable } from '../src/main/paths';
import type { ResolvedPaths } from '../src/main/paths';

let dir: string;
let paths: ResolvedPaths;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyre-store-'));
  paths = {
    mode: 'env', dir,
    notesFile: path.join(dir, 'notes.json'),
    settingsFile: path.join(dir, 'settings.json'),
    fellBackFrom: null,
  };
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win lock */ } });

describe('migration v1 → v2', () => {
  it('adds placement, drops stock, bumps version, is idempotent', () => {
    const v1 = { version: 1, notes: [{ id: 'n_abc123', topic: 'A', comment: 'b', due: null, created: 'x', updated: 'x', done: false, doneAt: null, stock: 'bone', source: 'user' }] };
    const r1 = migrate(v1);
    expect(r1.changed).toBe(true);
    expect(r1.file.version).toBe(2);
    expect(r1.file.notes[0].placement).toEqual({ mode: 'auto' });
    expect('stock' in r1.file.notes[0]).toBe(false);
    const r2 = migrate(JSON.parse(JSON.stringify(r1.file)));
    expect(r2.changed).toBe(false);
  });

  it('backs up the original v1 file and writes v2 once', () => {
    fs.writeFileSync(paths.notesFile, JSON.stringify({ version: 1, notes: [{ id: 'n_1', topic: 'A', comment: 'b', due: null, created: 'x', updated: 'x', done: false, doneAt: null, stock: 'slate', source: 'user' }] }));
    const s = new Store(paths);
    s.load();
    expect(fs.existsSync(path.join(dir, 'notes.v1.bak.json'))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(paths.notesFile, 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.notes[0].placement.mode).toBe('auto');
  });
});

describe('store writes', () => {
  it('writes atomically and leaves no .tmp behind', () => {
    const s = new Store(paths);
    s.load();
    const n = s.add({ topic: 'T', comment: 'c' });
    expect(fs.existsSync(paths.notesFile + '.tmp')).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(paths.notesFile, 'utf8'));
    expect(onDisk.notes[0].id).toBe(n.id);
    expect(onDisk.notes[0].placement).toEqual({ mode: 'auto' });
  });

  it('bank sets bankedAt and never touches due; unbank clears both', () => {
    const s = new Store(paths);
    s.load();
    const due = new Date(Date.now() + 3600e3).toISOString();
    const n = s.add({ topic: 'T', comment: 'c', due });
    const until = new Date(Date.now() + 7200e3).toISOString();
    const b = s.bank(n.id, until);
    expect(b.due).toBe(due);
    expect(b.bankedUntil).toBe(until);
    expect(typeof b.bankedAt).toBe('string');
    const u = s.unbank(n.id);
    expect(u.bankedUntil).toBeNull();
    expect(u.bankedAt).toBeNull();
  });

  it('move pins, release un-pins, correct keeps pinnedAt', () => {
    const s = new Store(paths);
    s.load();
    const n = s.add({ topic: 'T', comment: 'c' });
    const m = s.move(n.id, 1, 3);
    expect(m.placement.mode).toBe('manual');
    const pinnedAt = (m.placement as any).pinnedAt;
    s.correct([{ id: n.id, col: 0, row: 3 }]);
    const c = s.get(n.id)!;
    expect(c.placement).toEqual({ mode: 'manual', col: 0, row: 3, pinnedAt });
    expect(s.release(n.id).placement).toEqual({ mode: 'auto' });
  });
});

describe('watcher', () => {
  it('picks up an external edit and does not echo its own writes', async () => {
    const s = new Store(paths);
    s.load();
    s.watch();
    let changes = 0;
    s.on('change', () => changes++);

    // Own write: emits change once (from write()), watcher must not add another.
    s.add({ topic: 'A', comment: 'own' });
    await sleep(500);
    expect(changes).toBe(1);

    // External write.
    const file = JSON.parse(fs.readFileSync(paths.notesFile, 'utf8'));
    file.notes.push({ id: 'n_ext001', topic: 'EXT', comment: 'from editor', due: null, created: 'x', updated: 'x', done: false, doneAt: null, placement: { mode: 'auto' }, source: 'agent' });
    fs.writeFileSync(paths.notesFile, JSON.stringify(file, null, 2));
    await sleep(700);
    expect(changes).toBe(2);
    expect(s.notes().map((n) => n.id)).toContain('n_ext001');
    s.unwatch();
  });
});

describe('paths', () => {
  it('honours PYRE_DATA when writable', () => {
    const r = resolvePaths({ PYRE_DATA: dir });
    expect(r.mode).toBe('env');
    expect(r.notesFile).toBe(path.join(dir, 'notes.json'));
  });
  it('probeWritable is a real write', () => {
    expect(probeWritable(dir)).toBe(true);
    expect(probeWritable(path.join(dir, 'a', 'b'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'a', 'b')).length).toBe(0);
  });
});
