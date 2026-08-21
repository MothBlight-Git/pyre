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
import { Agent , claimsAChange , extractInlineToolCalls, stripInlineToolCalls } from '../src/main/agent';
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

describe('local models (Ollama / phi-4 shaped)', () => {
  /** Reply with an OpenAI-style error, the way Ollama's compat layer does. */
  const errorOnce = (status: number, message: string) => ({ __error: { status, message } });

  beforeEach(() => {
    // Extend the stub so a queued entry can be an error response.
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        const body: any = queue.shift() ?? say('(stub ran out of replies)');
        if (body.__error) {
          res.writeHead(body.__error.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: body.__error.message, type: 'invalid_request_error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'stub', ...body }));
      });
    });
  });

  it('falls back to a plain answer when the model cannot call tools', async () => {
    // What Ollama says for a model like plain phi4, which has no tool template.
    queue = [
      errorOnce(400, 'registry.ollama.ai/library/phi4 does not support tools'),
      say('You have four notes, one overdue.'),
    ];
    store.say('user', 'what is on my wall?');
    const r = await agentFor({ model: 'phi4' }).respond();
    expect(r?.ok).toBe(true);
    expect(r?.text).toContain('You have four notes');
    // It must admit it cannot change anything, and name models that can.
    expect(r?.text).toMatch(/cannot call tools/i);
    // Recommends a model that actually calls tools. phi4-mini does not:
    // it accepts the tools parameter, then answers without using them.
    expect(r?.text).toMatch(/qwen2.5|llama3.1/);
    // The retry dropped `tools` rather than sending them again.
    expect(seen[0].tools).toBeTruthy();
    expect(seen[1].tools).toBeUndefined();
  });

  it('tells you to pull a model that is not installed', async () => {
    queue = [errorOnce(404, 'model "phi4-mini" not found, try pulling it first')];
    store.say('user', 'hello');
    const r = await agentFor({ model: 'phi4-mini' }).respond();
    expect(r?.ok).toBe(false);
    expect(store.messages().at(-1)!.text).toMatch(/ollama pull phi4-mini/);
  });

  it('accepts tool arguments as an object, which local runtimes emit', async () => {
    queue = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        // Not a JSON string — the shape Ollama sometimes returns.
        { id: 'c1', type: 'function', function: { name: 'add_note', arguments: { topic: 'LOCAL', comment: 'from a local model' } } },
      ] } }] },
      say('Added it.'),
    ];
    store.say('user', 'add a note');
    const r = await agentFor().respond();
    expect(r?.ok).toBe(true);
    expect(store.notes()[0]).toMatchObject({ topic: 'LOCAL' });
  });

  it('recovers JSON wrapped in a markdown fence', async () => {
    queue = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'add_note', arguments: '```json\n{"topic":"FENCED","comment":"x"}\n```' } },
      ] } }] },
      say('Done.'),
    ];
    store.say('user', 'add');
    await agentFor().respond();
    expect(store.notes()[0]).toMatchObject({ topic: 'FENCED' });
  });

  it('sends max_tokens, not max_completion_tokens, to non-OpenAI endpoints', async () => {
    queue = [say('ok')];
    store.say('user', 'hi');
    await agentFor().respond();   // providerId 'custom' → default max_tokens
    expect(seen[0].max_tokens).toBe(8000);
    expect(seen[0].max_completion_tokens).toBeUndefined();
  });
});

describe('hallucinated changes', () => {
  // phi4-mini, asked to add a note, answered "Added OLLAMA, "local model
  // works", due in two days." having called no tool at all. Relaying that to
  // the user is worse than any error, so the claim has to be caught.
  it('catches a claim of a change that never happened', () => {
    expect(claimsAChange('Added OLLAMA, "local model works", due in two days.')).toBe(true);
    expect(claimsAChange('Your note has been added successfully.')).toBe(true);
    expect(claimsAChange("Done. I've moved winwater to Friday.")).toBe(true);
    expect(claimsAChange('Okay, deleted it.')).toBe(true);
    expect(claimsAChange('Marked done.')).toBe(true);
  });

  it('leaves honest read answers alone', () => {
    expect(claimsAChange('Two notes are burning: WINWATER and TAXES.')).toBe(false);
    expect(claimsAChange('Nothing is due today.')).toBe(false);
    expect(claimsAChange('You have 8 notes, 3 of them dated.')).toBe(false);
    expect(claimsAChange('Which note did you mean?')).toBe(false);
    // Mentions a past event without claiming to have caused it.
    expect(claimsAChange('WINWATER was added yesterday and is due Friday.')).toBe(false);
  });
});

describe('inline tool calls', () => {
  // Verbatim from a real phi4-mini reply through Ollama 0.32.15. It decided
  // to call the tool correctly, but wrote the call into the content instead
  // of tool_calls, so Ollama never lifted it out.
  const real =
    'I\'m adding a note with the topic "OLLAMA," the comment "local model works," ' +
    'and a deadline for 2 days from now.\n\n' +
    '[{"name": "add_note", "arguments": {"topic": "OLLAMA", "comment": "local model works", "due": "in 2 days"}}]';

  it('reads a call the runtime failed to parse', () => {
    const calls = extractInlineToolCalls(real);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('add_note');
    expect((calls[0].arguments as Record<string, unknown>).topic).toBe('OLLAMA');
  });

  it('reads a call after a literal tool_call token', () => {
    const calls = extractInlineToolCalls('<|tool_call|>{"name":"snuff_note","arguments":{"id":"n_1"}}');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('snuff_note');
  });

  it('handles several calls, and nesting', () => {
    const calls = extractInlineToolCalls(
      '[{"name":"add_note","arguments":{"topic":"A","comment":"x"}},' +
      '{"name":"move_note","arguments":{"id":"n_1","col":0,"row":0}}]');
    expect(calls.map((c) => c.name)).toEqual(['add_note', 'move_note']);
  });

  it('is not fooled by ordinary prose or unrelated JSON', () => {
    expect(extractInlineToolCalls('Two notes are burning.')).toEqual([]);
    expect(extractInlineToolCalls('The file is {"version": 2, "notes": []}.')).toEqual([]);
    expect(extractInlineToolCalls('')).toEqual([]);
  });

  it('keeps the JSON out of the talk lane', () => {
    const clean = stripInlineToolCalls(real);
    expect(clean).not.toMatch(/"arguments"/);
    expect(clean).toMatch(/adding a note/);
  });
});

describe('claim tenses', () => {
  // "Banking GROCERIES until Sunday." — real phi4-mini output, no tool called,
  // nothing banked. The progressive slipped past a past-tense-only verb list.
  it('catches progressive claims', () => {
    expect(claimsAChange('Banking GROCERIES until Sunday.')).toBe(true);
    expect(claimsAChange("I'm moving WINWATER to Friday.")).toBe(true);
    expect(claimsAChange('Setting the deadline to 5pm.')).toBe(true);
  });
  it('still leaves questions and reads alone', () => {
    expect(claimsAChange('Banking damps the fire without touching the deadline.')).toBe(true); // borderline: starts with the verb — acceptable false positive, only fires when no tool ran
    expect(claimsAChange('Should I bank it until Sunday?')).toBe(false);
    expect(claimsAChange('The hottest note is TAXES.')).toBe(false);
  });
});

describe('argument key aliases', () => {
  it('reads parameters and args as arguments', () => {
    expect(extractInlineToolCalls('[{"name":"add_note","parameters":{"topic":"A","comment":"x"}}]')[0].arguments).toEqual({ topic: 'A', comment: 'x' });
    expect(extractInlineToolCalls('{"name":"snuff_note","args":{"id":"n_1"}}')[0].arguments).toEqual({ id: 'n_1' });
  });
});
