/**
 * The OpenAI-compatible path drives Gemini, OpenRouter, Groq, Ollama and
 * LM Studio, so it is worth testing against a stub that speaks the wire
 * protocol rather than only typechecking it. The stub stands in for any of
 * them: same chat-completions shape, same tool-call round trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { Store } from '../src/main/store';
import { Agent } from '../src/main/agent';
import { buildToolDefs } from '../src/main/tool-defs';
import { PRESETS, preset } from '../src/main/providers';

let dir: string;
let store: Store;
let server: http.Server;
let port: number;
/** Every chat-completions body the stub received. */
let seen: any[] = [];
/** Queued responses, one per request. */
let queue: any[] = [];

const at = (min: number) => new Date(Date.now() + min * 60000).toISOString();
const say = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });
const callTool = (name: string, args: unknown) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] } }],
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyre-prov-'));
  store = new Store({ mode: 'env', dir, notesFile: path.join(dir, 'notes.json'), settingsFile: path.join(dir, 'settings.json'), fellBackFrom: null });
  store.load();
  seen = []; queue = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      const body = queue.shift() ?? say('(stub ran out of replies)');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'stub', ...body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win lock */ }
});

const agentFor = (overrides: Partial<{ model: string }> = {}) =>
  new Agent(store, () => ({
    providerId: 'custom',
    model: overrides.model ?? 'stub-model',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'stub',
  }));

describe('OpenAI-compatible provider', () => {
  it('answers a plain question and records the reply in the lane', async () => {
    queue = [say('Nothing on the wall yet.')];
    store.say('user', 'what is on my wall?');
    const r = await agentFor().respond();
    expect(r?.ok).toBe(true);
    const msgs = store.messages();
    expect(msgs.at(-1)).toMatchObject({ role: 'agent', text: 'Nothing on the wall yet.' });
    expect(msgs.find((m) => m.role === 'user')!.read).toBe(true);
  });

  it('sends the tools in OpenAI function shape, with the system prompt first', async () => {
    queue = [say('ok')];
    store.say('user', 'hi');
    await agentFor().respond();
    const body = seen[0];
    expect(body.model).toBe('stub-model');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('Pyre');
    expect(body.messages[1]).toMatchObject({ role: 'user', content: 'hi' });
    const names = body.tools.map((t: any) => t.function.name);
    expect(names).toContain('add_note');
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.parameters.type).toBe('object');
  });

  it('runs a tool call and feeds the result back for a second turn', async () => {
    queue = [
      callTool('add_note', { topic: 'WINWATER', comment: 'Send BEP', due: '90m' }),
      say('Added WINWATER, due in 90 minutes.'),
    ];
    store.say('user', 'add winwater send bep due in 90m');
    const r = await agentFor().respond();
    expect(r?.ok).toBe(true);
    // The tool actually wrote to the store.
    const notes = store.notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ topic: 'WINWATER', source: 'agent' });
    // The second request carried the tool result back.
    const second = seen[1];
    const toolMsg = second.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(JSON.parse(toolMsg.content).topic).toBe('WINWATER');
  });

  it('reports a bad tool name to the model instead of crashing', async () => {
    queue = [callTool('not_a_tool', {}), say('That tool does not exist.')];
    store.say('user', 'do something odd');
    const r = await agentFor().respond();
    expect(r?.ok).toBe(true);
    expect(seen[1].messages.find((m: any) => m.role === 'tool').content).toMatch(/No such tool/);
  });

  it('survives malformed tool arguments', async () => {
    queue = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'add_note', arguments: '{not json' } },
      ] } }] },
      say('I could not read those arguments.'),
    ];
    store.say('user', 'add a note');
    const r = await agentFor().respond();
    expect(r?.ok).toBe(true);
    expect(seen[1].messages.find((m: any) => m.role === 'tool').content).toMatch(/could not parse/i);
    expect(store.notes()).toHaveLength(0);
  });

  it('stops rather than looping forever if the model keeps calling tools', async () => {
    queue = Array.from({ length: 20 }, () => callTool('list_notes', {}));
    store.say('user', 'loop please');
    const r = await agentFor().respond();
    expect(r?.ok).toBe(true);
    expect(r?.text).toMatch(/stuck/i);
    expect(seen.length).toBeLessThanOrEqual(8); // MAX_TOOL_ROUNDS
  });

  it('replays lane history and starts on a user turn', async () => {
    store.say('agent', 'an opening line from the agent');
    store.say('user', 'first');
    store.markRead('user');
    store.say('agent', 'reply');
    store.say('user', 'second');
    queue = [say('ok')];
    await agentFor().respond();
    const roles = seen[0].messages.map((m: any) => m.role);
    expect(roles[0]).toBe('system');
    expect(roles[1]).toBe('user');           // leading agent line dropped
    expect(roles.at(-1)).toBe('user');
  });

  it('turns an HTTP failure into one readable line', async () => {
    await new Promise<void>((r) => server.close(() => r()));   // nothing listening
    store.say('user', 'hello');
    const r = await agentFor().respond();
    expect(r?.ok).toBe(false);
    expect(store.messages().at(-1)!.text).toMatch(/could not reach|something went wrong/i);
    server = http.createServer(() => {});                       // afterEach closes it
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  it('does nothing when there is no unread user message', async () => {
    store.say('user', 'hi');
    store.markRead('user');
    expect(await agentFor().respond()).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe('provider presets', () => {
  it('offers a key-free local option and an OpenAI-compatible Gemini', () => {
    const gemini = preset('gemini');
    expect(gemini.kind).toBe('openai');
    expect(gemini.baseUrl).toContain('generativelanguage.googleapis.com');
    expect(preset('ollama').needsKey).toBe(false);
    expect(preset('anthropic').kind).toBe('anthropic');
  });

  it('falls back to Anthropic for an unknown id rather than throwing', () => {
    expect(preset('nonsense').id).toBe('anthropic');
  });

  it('every preset has a model and a hint', () => {
    for (const p of PRESETS) {
      expect(p.label).toBeTruthy();
      expect(p.hint).toBeTruthy();
      if (p.id !== 'custom') expect(p.defaultModel).toBeTruthy();
    }
  });
});

describe('tool defs are provider-neutral', () => {
  it('uses plain JSON Schema every provider accepts', () => {
    for (const t of buildToolDefs(store)) {
      const s: any = t.schema;
      expect(s.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(20);
      for (const [name, prop] of Object.entries<any>(s.properties)) {
        // Gemini rejects the array form of `type`; everything must be a scalar.
        expect(typeof prop.type, `${t.name}.${name}`).toBe('string');
      }
    }
  });

  it('accepts the string "null" as an explicit clear, which models emit', async () => {
    const defs = buildToolDefs(store);
    const add = defs.find((t) => t.name === 'add_note')!;
    const out = JSON.parse(await add.run({ topic: 'T', comment: 'c', due: 'null' }));
    expect(out.due).toBeNull();
    const update = defs.find((t) => t.name === 'update_note')!;
    const n = store.add({ topic: 'X', comment: 'y', due: at(30) });
    const cleared = JSON.parse(await update.run({ id: n.id, due: 'null' }));
    expect(cleared.due).toBeNull();
    expect(cleared.state).toBe('cold');
  });
});
