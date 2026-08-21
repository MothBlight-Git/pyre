/**
 * The assistant's tools, defined once in a provider-neutral shape.
 *
 * Anthropic and OpenAI-compatible providers want different wrappers around the
 * same thing: a name, a description, a JSON Schema and a function. Defining
 * them here and adapting per provider means Gemini, OpenAI, OpenRouter, a local
 * Ollama and Claude all drive the identical implementation — which is also the
 * one the MCP server exposes, via the shared enrichment in mcp/enrich.ts.
 *
 * Every `run` returns a string: JSON for data, plain prose for a failure the
 * model should read and recover from. Nothing here throws.
 */
import type { Store } from './store';
import { enrichNote, layoutFor, resolveDue } from '../mcp/enrich';
import { gridMetrics } from '../shared/grid';
import { parseLine, formatDue } from '../shared/parse';
import { evaluate } from '../shared/heat';
import type { Note } from '../shared/types';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Kept plain so every SDK accepts it. */
  schema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
  /**
   * True when the tool changes the wall. Weak local models sometimes answer a
   * "move X to friday" with a confident "Done." and no tool call at all, so
   * the caller needs to know whether anything actually happened before it
   * repeats the claim to the user. See `claimsAChange` in agent.ts.
   */
  mutates?: boolean;
}

/**
 * Models — small local ones reliably, big ones occasionally — pass a topic
 * where an id belongs ("move OLLAMA to friday"). When the string is not an
 * id but names exactly one live note, that note is unambiguous, so use it.
 * Two notes sharing the topic stays an error: guessing between them would
 * change the wrong one silently.
 */
const resolveId = (store: Store, raw: unknown): string => {
  const v = String(raw ?? '');
  const notes = store.notes();
  if (notes.some((n) => n.id === v)) return v;
  const named = notes.filter((n) => !n.done && n.topic.toLowerCase() === v.trim().toLowerCase());
  return named.length === 1 ? named[0].id : v;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', minimum: 0, description });
/**
 * Nullable string. Gemini's OpenAI-compatible layer rejects the JSON-Schema
 * array form (`type: ['string','null']`), so express it as a plain string and
 * say "or the word null" in the description — every provider accepts that.
 */
const nullableStr = (description: string) => ({ type: 'string', description });

export function buildToolDefs(store: Store): ToolDef[] {
  const slotsNow = () => layoutFor(store, store.notes(), new Date()).slots;
  const show = (n: Note) => JSON.stringify(enrichNote(n, new Date(), slotsNow()));
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
  /** Models sometimes send the string "null" for an explicit clear. */
  const nullish = (v: unknown) => v === null || v === 'null' || v === '';

  return [
    {
      name: 'list_notes',
      description: 'List the notes on the wall with computed burn (0–30%), state, minutes to due, and grid slot. Call this before answering anything about what is on the wall.',
      schema: obj({
        includeDone: { type: 'boolean', description: 'Include snuffed notes from the archive' },
        topic: str('Only notes with this topic (case-insensitive)'),
        burningOnly: { type: 'boolean', description: 'Only notes whose fuse is lit (burn > 0)' },
      }),
      run: async (a) => {
        const now = new Date();
        const slots = layoutFor(store, store.notes(), now).slots;
        const topic = s(a.topic);
        let out = store.notes().filter((x) => a.includeDone || !x.done);
        if (topic) out = out.filter((x) => x.topic.toLowerCase() === topic.toLowerCase());
        let rows = out.map((x) => enrichNote(x, now, slots));
        if (a.burningOnly) rows = rows.filter((r) => r.burn > 0);
        rows.sort((x, y) => y.burn - x.burn || y.created.localeCompare(x.created));
        return JSON.stringify(rows);
      },
    },
    {
      name: 'add_note',
      mutates: true,
      description: 'Put a new note on the wall. `due` accepts ISO or any composer form ("fri 9am", "tomorrow", "3d", "8/21 3pm"); omit it for no deadline. Give col and row only if the user asked for a specific position.',
      schema: obj({
        topic: str('Short topic, e.g. WINWATER. Empty becomes UNSORTED'),
        comment: str('What the note says'),
        due: nullableStr('Deadline, or the word null for none'),
        col: int('Column to pin to'),
        row: int('Row to pin to'),
      }, ['topic', 'comment']),
      run: async (a) => {
        const raw = s(a.due);
        const due = nullish(a.due) ? null : resolveDue(store, raw);
        if (due === false) return `Could not read "${raw}" as a date. Ask the user, or use an ISO date.`;
        const col = n(a.col), row = n(a.row);
        const placement = col !== undefined && row !== undefined
          ? { mode: 'manual' as const, col, row, pinnedAt: new Date().toISOString() }
          : { mode: 'auto' as const };
        // An empty topic files under UNSORTED, same as a leading slash in the composer.
        return show(store.add({ topic: String(a.topic ?? '').trim() || 'UNSORTED', comment: String(a.comment ?? ''), due, source: 'agent', placement }));
      },
    },
    {
      name: 'update_note',
      mutates: true,
      description: "Change a note's topic, comment and/or due. Pass due as the word null to remove the deadline, which makes the note cold so it stops burning.",
      schema: obj({
        id: str('Note id, or the exact topic if it names only one note'),
        topic: str('New topic'),
        comment: str('New comment'),
        due: nullableStr('New deadline, or the word null to clear it'),
      }, ['id']),
      run: async (a) => {
        const patch: { topic?: string; comment?: string; due?: string | null } = {};
        if (s(a.topic) !== undefined) patch.topic = s(a.topic)!;
        if (s(a.comment) !== undefined) patch.comment = s(a.comment)!;
        if (a.due !== undefined) {
          if (nullish(a.due)) patch.due = null;
          else {
            const due = resolveDue(store, s(a.due));
            if (due === false) return `Could not read "${s(a.due)}" as a date.`;
            patch.due = due;
          }
        }
        try { return show(store.update(resolveId(store, a.id), patch)); }
        catch (e) { return (e as Error).message; }
      },
    },
    {
      name: 'move_note',
      mutates: true,
      description: 'Pin a note to a grid cell, exactly as dragging it would. It holds that cell and hotter notes flow around it. Call get_grid first if you need to know what is free.',
      schema: obj({ id: str('Note id, or the exact topic if it names only one note'), col: int('Column'), row: int('Row') }, ['id', 'col', 'row']),
      run: async (a) => {
        try { return show(store.move(resolveId(store, a.id), Number(a.col), Number(a.row))); }
        catch (e) { return (e as Error).message; }
      },
    },
    {
      name: 'release_note',
      mutates: true,
      description: 'Release a pinned note back to automatic placement, so it sorts by heat again.',
      schema: obj({ id: str('Note id, or the exact topic if it names only one note') }, ['id']),
      run: async (a) => {
        try { return show(store.release(resolveId(store, a.id))); } catch (e) { return (e as Error).message; }
      },
    },
    {
      name: 'bank_note',
      mutates: true,
      description: 'Bank (snooze) a note until a time — damps the fire without ever changing the deadline. Pass until as the word null to un-bank.',
      schema: obj({
        id: str('Note id, or the exact topic if it names only one note'),
        until: nullableStr('When banking ends ("2h", "tomorrow 9am"), or the word null to un-bank'),
      }, ['id', 'until']),
      run: async (a) => {
        try {
          if (nullish(a.until)) return show(store.unbank(resolveId(store, a.id)));
          const until = resolveDue(store, s(a.until));
          if (!until) return `Could not read "${s(a.until)}" as a time.`;
          return show(store.bank(resolveId(store, a.id), until));
        } catch (e) { return (e as Error).message; }
      },
    },
    {
      name: 'snuff_note',
      mutates: true,
      description: 'Mark a note done. It leaves the wall for the Done archive and can be restored.',
      schema: obj({ id: str('Note id, or the exact topic if it names only one note') }, ['id']),
      run: async (a) => {
        try { return show(store.snuff(resolveId(store, a.id))); } catch (e) { return (e as Error).message; }
      },
    },
    {
      name: 'delete_note',
      mutates: true,
      description: 'Permanently delete a note. Prefer snuff_note unless the user clearly wants it gone for good.',
      schema: obj({ id: str('Note id, or the exact topic if it names only one note') }, ['id']),
      run: async (a) => {
        try { return JSON.stringify(store.remove(resolveId(store, a.id))); } catch (e) { return (e as Error).message; }
      },
    },
    {
      name: 'get_grid',
      description: 'The occupancy map of the wall: columns, note size, which cell each note holds, and the first free cell. Use before pinning something.',
      schema: obj({}),
      run: async () => {
        const now = new Date();
        const all = store.notes();
        const m = gridMetrics(store.settings().railWidth);
        const { slots } = layoutFor(store, all, now);
        const cells = all.flatMap((x) => {
          const slot = slots.get(x.id);
          if (!slot) return [];
          return [{ col: slot.col, row: slot.row, id: x.id, topic: x.topic, state: evaluate(x, now).state, placement: x.placement.mode }];
        }).sort((x, y) => x.row - y.row || x.col - y.col);
        const taken = new Set(cells.map((c) => `${c.col},${c.row}`));
        let free = { col: 0, row: 0 };
        while (taken.has(`${free.col},${free.row}`)) {
          free = free.col + 1 < m.cols ? { col: free.col + 1, row: free.row } : { col: 0, row: free.row + 1 };
        }
        return JSON.stringify({ cols: m.cols, noteSize: m.noteSize, rows: cells.length ? cells[cells.length - 1].row + 1 : 0, firstFree: free, cells });
      },
    },
    {
      name: 'parse_line',
      description: 'Dry-run the composer grammar "topic / comment / due" to see what it would create and how a date phrase resolves, without writing anything.',
      schema: obj({ line: str('The line to parse') }, ['line']),
      run: async (a) => {
        const p = parseLine(String(a.line ?? ''), { defaultTime: store.settings().defaultDueTime });
        return JSON.stringify({ ...p, dueLocal: p.due ? formatDue(p.due) : null });
      },
    },
  ];
}
