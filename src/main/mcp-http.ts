/**
 * Local streamable-HTTP MCP endpoint served by the running app.
 *
 *   http://127.0.0.1:<port>/mcp
 *
 * Why, when `Pyre.exe --mcp` already exists: the single-file portable exe is an
 * NSIS launcher that extracts and ExecWait()s the real app WITHOUT inheriting
 * stdio, so stdio MCP cannot work through it. This endpoint works from any
 * build the moment the rail is running, needs no Node on the machine, and
 * Cursor / Claude Code / any streamable-HTTP client can point straight at it.
 *
 * Bound to 127.0.0.1 only. Stateless: one McpServer + transport per request
 * (the SDK's recommended pattern), all sharing the app's live Store — so writes
 * hit the same in-memory state + atomic writer + watcher as the UI.
 */
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Store } from './store';
import { registerPyreTools, PYRE_MCP_VERSION } from '../mcp/tools';

export const DEFAULT_MCP_PORT = 41777;

export interface McpHttp { port: number; url: string; close(): void }

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve(undefined);
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function startMcpHttp(store: Store, port: number, log: (m: string) => void): Promise<McpHttp | null> {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // Simple liveness/info endpoint for humans and health checks.
      if (url.pathname === '/' || url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'pyre', version: PYRE_MCP_VERSION, mcp: '/mcp', notesFile: store.paths.notesFile }));
        return;
      }
      if (url.pathname !== '/mcp') { res.writeHead(404); res.end(); return; }
      // DNS-rebinding guard: only accept requests addressed to loopback.
      const host = (req.headers.host ?? '').split(':')[0];
      if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
        res.writeHead(403); res.end('forbidden host'); return;
      }
      try {
        const mcp = new McpServer({ name: 'pyre', version: PYRE_MCP_VERSION });
        registerPyreTools(mcp, store, () => store.notes()); // in-process: the store IS the live state
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close(); mcp.close(); });
        await mcp.connect(transport);
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        await transport.handleRequest(req, res, body);
      } catch (e) {
        log(`mcp-http error: ${(e as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
        }
      }
    });
    server.on('error', (e) => { log(`mcp-http could not listen on ${port}: ${(e as Error).message}`); resolve(null); });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      const urlStr = `http://127.0.0.1:${p}/mcp`;
      log(`mcp-http listening at ${urlStr}`);
      resolve({ port: p, url: urlStr, close: () => server.close() });
    });
  });
}
