/**
 * End-to-end: `electron . --mcp` must answer JSON-RPC on stdio, and its
 * add_note must land in notes.json (which the app's watcher would pick up).
 * Requires `npm run build:main` first (the test builds if dist is missing).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
// The electron package's default export is the path to the binary.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBin: string = require('electron');

let dir: string;
let child: ChildProcess;
let buffer = '';
const pending = new Map<number, (v: any) => void>();
let nextId = 1;

function send(method: string, params: any = {}): Promise<any> {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  child.stdin!.write(msg + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); } }, 15000);
  });
}
function notify(method: string, params: any = {}) {
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

beforeAll(async () => {
  if (!fs.existsSync(path.join(root, 'dist', 'mcp', 'server.js'))) execSync('npm run build:main', { cwd: root, stdio: 'ignore' });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyre-mcp-'));
  child = spawn(electronBin, ['.', '--mcp'], {
    cwd: root,
    env: { ...process.env, PYRE_DATA: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
      } catch { /* not JSON — ignore */ }
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', () => { /* logs */ });
}, 60000);

afterAll(() => {
  try { child.kill(); } catch { /* ignore */ }
  if (process.platform === 'win32' && child.pid) { try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ } }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Pyre --mcp', () => {
  it('answers initialize and lists the spec tools', async () => {
    const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.result.serverInfo.name).toBe('pyre');
    notify('notifications/initialized');
    const tools = await send('tools/list');
    const names = tools.result.tools.map((t: any) => t.name).sort();
    for (const n of ['list_notes', 'add_note', 'update_note', 'move_note', 'release_note', 'bank_note', 'snuff_note', 'delete_note', 'parse_line', 'get_grid']) {
      expect(names).toContain(n);
    }
  }, 30000);

  it('add_note writes notes.json with source agent and computed burn', async () => {
    const r = await send('tools/call', { name: 'add_note', arguments: { topic: 'WINWATER', comment: 'Send BEP', due: '90m' } });
    const note = JSON.parse(r.result.content[0].text);
    expect(note.source).toBe('agent');
    expect(note.state).toBe('due');
    expect(note.burn).toBeGreaterThan(0);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.notes.find((n: any) => n.id === note.id).source).toBe('agent');
  }, 30000);

  it('list_notes reflects an edit made directly to the file (no watcher needed)', async () => {
    const file = path.join(dir, 'notes.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    j.notes.push({ id: 'n_direct', topic: 'DIRECT', comment: 'edited by hand', due: null, created: 'x', updated: 'x', done: false, doneAt: null, placement: { mode: 'auto' }, source: 'user' });
    fs.writeFileSync(file, JSON.stringify(j));
    const r = await send('tools/call', { name: 'list_notes', arguments: {} });
    const rows = JSON.parse(r.result.content[0].text);
    expect(rows.map((n: any) => n.id)).toContain('n_direct');
    expect(rows[0].slot).toEqual({ col: 0, row: 0 }); // hottest first
  }, 30000);

  it('get_grid and parse_line', async () => {
    const g = JSON.parse((await send('tools/call', { name: 'get_grid', arguments: {} })).result.content[0].text);
    expect(g.cols).toBe(2);
    expect(g.cells.length).toBe(2);
    const p = JSON.parse((await send('tools/call', { name: 'parse_line', arguments: { line: 'a / b / tomorrow 9am' } })).result.content[0].text);
    expect(p.valid).toBe(true);
    expect(p.dueLocal).toMatch(/09:00$/);
  }, 30000);

  it('bank never alters due; move pins; release un-pins', async () => {
    const list = JSON.parse((await send('tools/call', { name: 'list_notes', arguments: { topic: 'WINWATER' } })).result.content[0].text);
    const id = list[0].id;
    const due = list[0].due;
    const b = JSON.parse((await send('tools/call', { name: 'bank_note', arguments: { id, until: '2h' } })).result.content[0].text);
    expect(b.due).toBe(due);
    expect(b.state).toBe('banked');
    const m = JSON.parse((await send('tools/call', { name: 'move_note', arguments: { id, col: 1, row: 3 } })).result.content[0].text);
    expect(m.placement.mode).toBe('manual');
    expect(m.slot).toEqual({ col: 1, row: 3 });
    const rel = JSON.parse((await send('tools/call', { name: 'release_note', arguments: { id } })).result.content[0].text);
    expect(rel.placement.mode).toBe('auto');
  }, 30000);
});
