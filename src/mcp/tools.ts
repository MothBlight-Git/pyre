/**
 * PYRE MCP tools (CLAUDE.md §8.2). Transport-agnostic: registered on an
 * McpServer by both the stdio entry (src/mcp/server.ts, `Pyre.exe --mcp`) and
 * the in-app local HTTP endpoint (src/main/mcp-http.ts).
 *
 * Imports shared/heat (THE burn curve), shared/grid (THE placement rule),
 * shared/parse (THE grammar) and main/store (THE file writer), so an agent and
 * the user are always looking at the same product.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Store } from '../main/store';
import { evaluate } from '../shared/heat';
import { layout, gridMetrics } from '../shared/grid';
import { parseLine, formatDue } from '../shared/parse';
import type { Note } from '../shared/types';

export const PYRE_MCP_VERSION = '0.2.0';

/**
 * @param fresh called before every tool: re-read the file if another process
 *   changed it (the stdio server has no watcher). The in-app server passes a no-op.
 */
export function registerPyreTools(server: McpServer, store: Store, fresh: () => Note[]): void {
function enrich(n: Note, now: Date, slots: Map<string, { col: number; row: number }>) {
  const b = evaluate(n, now);
  return {
    ...n,
    burn: Math.round(b.burn * 100) / 100,
    warmth: Math.round(b.warmth * 1000) / 1000,
    state: b.state,
    minutesToDue: b.minutesToDue === null ? null : Math.round(b.minutesToDue),
    label: b.label,
    dueLocal: n.due ? formatDue(n.due, now) : null,
    slot: slots.get(n.id) ?? null,
  };
}

function currentLayout(notes: Note[], now: Date) {
  const cols = gridMetrics(store.settings().railWidth).cols;
  const live = notes.filter((n) => !n.done);
  return { cols, ...layout(live, cols, now) };
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

server.registerTool('list_notes', {
  description: 'List notes with computed burn (0–30 %), warmth, state (cold|warming|due|burning|critical|overdue|gone-out|banked), minutesToDue, label and resolved grid slot. Done notes are excluded unless includeDone.',
  inputSchema: {
    includeDone: z.boolean().optional(),
    topic: z.string().optional().describe('Case-insensitive topic filter'),
    dueBefore: z.string().optional().describe('ISO date; only notes due before this'),
    burningOnly: z.boolean().optional().describe('Only notes whose fuse is lit (burn > 0)'),
  },
}, async (a) => {
  const now = new Date();
  const all = fresh();
  const { slots } = currentLayout(all, now);
  let out = all.filter((n) => a.includeDone || !n.done);
  if (a.topic) out = out.filter((n) => n.topic.toLowerCase() === a.topic!.toLowerCase());
  if (a.dueBefore) {
    const t = Date.parse(a.dueBefore);
    if (Number.isNaN(t)) return fail('dueBefore must be an ISO date');
    out = out.filter((n) => n.due && Date.parse(n.due) < t);
  }
  const rows = out.map((n) => enrich(n, now, slots));
  const filtered = a.burningOnly ? rows.filter((r) => r.burn > 0) : rows;
  filtered.sort((x, y) => y.burn - x.burn || (y.due ? 1 : 0) - (x.due ? 1 : 0) || y.created.localeCompare(x.created));
  return text(filtered);
});

server.registerTool('add_note', {
  description: 'Create a note. `due` accepts ISO or any composer form ("fri 9am", "tomorrow", "3d", "8/21 3pm"). Supplying col/row pins it to that cell (manual placement); omitting them leaves it auto (sorted by heat). source is "agent".',
  inputSchema: {
    topic: z.string().describe('Short topic, e.g. WINWATER. Empty → UNSORTED'),
    comment: z.string().min(1),
    due: z.string().nullable().optional(),
    col: z.number().int().min(0).optional(),
    row: z.number().int().min(0).optional(),
  },
}, async (a) => {
  fresh();
  const due = resolveDue(a.due);
  if (due === false) return fail(`Could not parse due: ${a.due}`);
  const placement = a.col !== undefined && a.row !== undefined
    ? { mode: 'manual' as const, col: a.col, row: a.row, pinnedAt: new Date().toISOString() }
    : { mode: 'auto' as const };
  const n = store.add({ topic: a.topic, comment: a.comment, due, source: 'agent', placement });
  const now = new Date();
  const { slots } = currentLayout(store.notes(), now);
  return text(enrich(n, now, slots));
});

server.registerTool('update_note', {
  description: 'Update topic, comment and/or due of a note. Pass due: null to remove the deadline.',
  inputSchema: {
    id: z.string(),
    topic: z.string().optional(),
    comment: z.string().min(1).optional(),
    due: z.string().nullable().optional(),
  },
}, async (a) => {
  fresh();
  const patch: { topic?: string; comment?: string; due?: string | null } = {};
  if (a.topic !== undefined) patch.topic = a.topic;
  if (a.comment !== undefined) patch.comment = a.comment;
  if (a.due !== undefined) {
    const due = resolveDue(a.due);
    if (due === false) return fail(`Could not parse due: ${a.due}`);
    patch.due = due;
  }
  return withNote(a.id, () => store.update(a.id, patch));
});

server.registerTool('move_note', {
  description: 'Pin a note to a grid cell (manual placement) exactly as a drag would. It will hold that cell; hotter notes flow around it.',
  inputSchema: { id: z.string(), col: z.number().int().min(0), row: z.number().int().min(0) },
}, async (a) => { fresh(); return withNote(a.id, () => store.move(a.id, a.col, a.row)); });

server.registerTool('release_note', {
  description: 'Release a pinned note back to auto placement (sorted by heat).',
  inputSchema: { id: z.string() },
}, async (a) => { fresh(); return withNote(a.id, () => store.release(a.id)); });

server.registerTool('bank_note', {
  description: 'Bank (snooze) a note until an ISO time or composer form ("2h", "tomorrow 9am"). Damps the fire; NEVER alters due. Pass until: null to un-bank.',
  inputSchema: { id: z.string(), until: z.string().nullable() },
}, async (a) => {
  fresh();
  if (a.until === null) return withNote(a.id, () => store.unbank(a.id));
  const until = resolveDue(a.until);
  if (!until) return fail(`Could not parse until: ${a.until}`);
  return withNote(a.id, () => store.bank(a.id, until));
});

server.registerTool('snuff_note', {
  description: 'Mark a note done. It leaves the wall and goes to the Done archive (restorable).',
  inputSchema: { id: z.string() },
}, async (a) => { fresh(); return withNote(a.id, () => store.snuff(a.id)); });

server.registerTool('restore_note', {
  description: 'Restore a done note to the wall with its original due date.',
  inputSchema: { id: z.string() },
}, async (a) => { fresh(); return withNote(a.id, () => store.restore(a.id)); });

server.registerTool('delete_note', {
  description: 'Permanently delete a note.',
  inputSchema: { id: z.string() },
}, async (a) => {
  fresh();
  try { return text(store.remove(a.id)); } catch (e) { return fail((e as Error).message); }
});

server.registerTool('parse_line', {
  description: 'Dry-run the composer grammar `topic / comment [/ due]` and see exactly what would be created, without writing anything.',
  inputSchema: { line: z.string() },
}, async (a) => {
  const p = parseLine(a.line, { defaultTime: store.settings().defaultDueTime });
  return text({ ...p, dueLocal: p.due ? formatDue(p.due) : null });
});

server.registerTool('list_messages', {
  description: 'Read the talk lane — the message channel between the user and you. The user types lines starting with ">" in the Pyre bar and they land here. Poll this at the start of a session, and whenever the user mentions Pyre, to see if anything is waiting. Unread user messages are the ones you have not answered yet.',
  inputSchema: {
    unreadOnly: z.boolean().optional().describe('Only messages the agent has not marked read yet'),
    limit: z.number().int().min(1).max(200).optional().describe('Most recent N (default 50)'),
    markRead: z.boolean().optional().describe('Mark the returned user messages as read'),
  },
}, async (a) => {
  fresh();
  let list = store.messages();
  if (a.unreadOnly) list = list.filter((m) => m.role === 'user' && !m.read);
  const limit = a.limit ?? 50;
  if (list.length > limit) list = list.slice(list.length - limit);
  if (a.markRead) store.markRead('user');
  return text({
    messages: list,
    unreadFromUser: store.messages().filter((m) => m.role === 'user' && !m.read).length,
    hint: 'Reply with send_message. The user sees it in the lane under the composer.',
  });
});

server.registerTool('send_message', {
  description: 'Write a line into the talk lane, visible to the user under the Pyre composer. Use it to answer a ">" message, to report what you changed on the wall, or to ask a question. Keep it short — the rail is 340px wide. This does NOT create a note; use add_note for that.',
  inputSchema: { text: z.string().min(1).describe('Plain text. No markdown rendering; newlines are kept.') },
}, async (a) => {
  fresh();
  try {
    const m = store.say('agent', a.text);
    store.markRead('user'); // answering implies you read it
    return text(m);
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool('get_grid', {
  description: 'Occupancy map of the wall: { cols, noteSize, rows, cells: [{col,row,id,topic,state,burn,placement}] } plus the first free cell, so you can reason about placement before pinning.',
  inputSchema: {},
}, async () => {
  const now = new Date();
  const all = fresh();
  const m = gridMetrics(store.settings().railWidth);
  const { slots } = currentLayout(all, now);
  const cells: Array<{ col: number; row: number; id: string; topic: string; state: string; burn: number; placement: string }> = [];
  let rows = 0;
  for (const n of all) {
    const s = slots.get(n.id);
    if (!s) continue;
    rows = Math.max(rows, s.row + 1);
    const b = evaluate(n, now);
    cells.push({ col: s.col, row: s.row, id: n.id, topic: n.topic, state: b.state, burn: Math.round(b.burn * 100) / 100, placement: n.placement.mode });
  }
  cells.sort((a, b) => a.row - b.row || a.col - b.col);
  const taken = new Set(cells.map((c) => `${c.col},${c.row}`));
  let free = { col: 0, row: 0 };
  for (;;) {
    if (!taken.has(`${free.col},${free.row}`)) break;
    free = free.col + 1 < m.cols ? { col: free.col + 1, row: free.row } : { col: 0, row: free.row + 1 };
  }
  return text({ cols: m.cols, noteSize: m.noteSize, rows, firstFree: free, dataFile: store.paths.notesFile, cells });
});

/** ISO passthrough or composer date form. Returns null for null/'' , false when unparsable. */
function resolveDue(input: string | null | undefined): string | null | false {
  if (input === null || input === undefined || input.trim() === '') return null;
  const s = input.trim();
  const direct = Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(direct)) return new Date(direct).toISOString();
  const p = parseLine(`x / y / ${s}`, { defaultTime: store.settings().defaultDueTime });
  if (p.due) return p.due;
  return Number.isNaN(direct) ? false : new Date(direct).toISOString();
}

function withNote(id: string, fn: () => Note) {
  try {
    const n = fn();
    const now = new Date();
    const { slots } = currentLayout(store.notes(), now);
    return text(enrich(n, now, slots));
  } catch (e) {
    return fail((e as Error).message);
  }
}
}
