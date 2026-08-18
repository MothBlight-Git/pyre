import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { Store } from '../src/main/store';
import { startMcpHttp, type McpHttp } from '../src/main/mcp-http';

let dir: string;
let store: Store;
let srv: McpHttp | null;

async function rpc(body: unknown, expectStatus = 200) {
  const r = await fetch(srv!.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(expectStatus);
  const text = await r.text();
  // Streamable HTTP may answer as SSE ("event: message\ndata: {...}") or plain JSON.
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyre-http-'));
  store = new Store({ mode: 'env', dir, notesFile: path.join(dir, 'notes.json'), settingsFile: path.join(dir, 'settings.json'), fellBackFrom: null });
  store.load();
  // 0 means "off" in settings, so pick a free high port for the test.
  const port = 42000 + Math.floor(Math.random() * 2000);
  srv = await startMcpHttp(store, port, () => {});
  expect(srv).not.toBeNull();
});
afterAll(() => { srv?.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('local HTTP MCP endpoint', () => {
  it('serves health + initialize', async () => {
    const h = await (await fetch(srv!.url.replace('/mcp', '/health'))).json();
    expect(h.name).toBe('pyre');
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(init.result.serverInfo.name).toBe('pyre');
  });

  it('add_note writes through the shared store and get_grid sees it', async () => {
    let changes = 0;
    store.on('change', () => changes++);
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_note', arguments: { topic: 'HTTP', comment: 'hello', due: 'tomorrow' } } });
    const note = JSON.parse(r.result.content[0].text);
    expect(note.source).toBe('agent');
    expect(note.state).toBe('warming');
    expect(changes).toBe(1);
    const g = JSON.parse((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_grid', arguments: {} } })).result.content[0].text);
    expect(g.cells.map((c: any) => c.id)).toContain(note.id);
    expect(fs.existsSync(path.join(dir, 'notes.json'))).toBe(true);
  });

  it('rejects a non-loopback Host header (DNS rebinding guard)', async () => {
    // fetch() refuses to override Host, so go through http.request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(srv!.url, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});
