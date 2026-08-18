/**
 * notes.json migration. v1 → v2 (CLAUDE.md §5.3):
 *   - every note gets placement: { mode: 'auto' }
 *   - `stock` is removed
 *   - version becomes 2
 * Idempotent: running on a v2 file is a no-op. Also repairs individual v2
 * records that are missing fields (a hand-edited file), so the app never
 * crashes on a slightly-wrong note.
 */
import type { Note, NoteFile, Placement, Message } from './types';

export interface MigrationResult {
  file: NoteFile;
  /** True when the caller should write the file back (and back up the original). */
  changed: boolean;
  fromVersion: number;
}

function isPlacement(p: unknown): p is Placement {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (o.mode === 'auto') return true;
  return (
    o.mode === 'manual' &&
    Number.isInteger(o.col) &&
    Number.isInteger(o.row) &&
    typeof o.pinnedAt === 'string'
  );
}

/** Repair one record in place; returns true if anything changed. */
export function normalizeNote(raw: Record<string, unknown>): { note: Note; changed: boolean } {
  let changed = false;
  const n = raw as unknown as Note & Record<string, unknown>;
  const nowIso = new Date().toISOString();

  if (typeof n.id !== 'string' || !n.id) { n.id = 'n_' + Math.random().toString(36).slice(2, 8); changed = true; }
  if (typeof n.topic !== 'string') { n.topic = String(n.topic ?? 'UNSORTED'); changed = true; }
  if (typeof n.comment !== 'string') { n.comment = String(n.comment ?? ''); changed = true; }
  if (n.due !== null && typeof n.due !== 'string') { n.due = null; changed = true; }
  if (typeof n.due === 'string' && Number.isNaN(Date.parse(n.due))) { n.due = null; changed = true; }
  if (typeof n.created !== 'string') { n.created = nowIso; changed = true; }
  if (typeof n.updated !== 'string') { n.updated = n.created; changed = true; }
  if (typeof n.done !== 'boolean') { n.done = !!n.done; changed = true; }
  if (n.doneAt !== null && typeof n.doneAt !== 'string') { n.doneAt = null; changed = true; }
  if (n.doneAt === undefined) { n.doneAt = null; changed = true; }
  if (n.bankedUntil !== undefined && n.bankedUntil !== null && typeof n.bankedUntil !== 'string') { n.bankedUntil = null; changed = true; }
  if (n.bankedAt !== undefined && n.bankedAt !== null && typeof n.bankedAt !== 'string') { n.bankedAt = null; changed = true; }
  if (!isPlacement(n.placement)) { n.placement = { mode: 'auto' }; changed = true; }
  if (typeof n.source !== 'string') { n.source = 'user'; changed = true; }
  if ('stock' in n) { delete (n as Record<string, unknown>).stock; changed = true; }
  return { note: n as Note, changed };
}

/** Repair one talk-lane message; returns null if it is beyond saving. */
export function normalizeMessage(raw: Record<string, unknown>): { message: Message; changed: boolean } | null {
  let changed = false;
  const m = raw as unknown as Message & Record<string, unknown>;
  if (typeof m.text !== 'string' || !m.text.trim()) return null;
  if (typeof m.id !== 'string' || !m.id) { m.id = 'm_' + Math.random().toString(36).slice(2, 8); changed = true; }
  if (m.role !== 'user' && m.role !== 'agent') { m.role = 'agent'; changed = true; }
  if (typeof m.created !== 'string' || Number.isNaN(Date.parse(m.created))) { m.created = new Date().toISOString(); changed = true; }
  if (typeof m.read !== 'boolean') { m.read = false; changed = true; }
  return { message: m as Message, changed };
}

export function migrate(input: unknown): MigrationResult {
  let changed = false;
  let fromVersion = 0;
  let notesRaw: unknown[] = [];
  let messagesRaw: unknown[] = [];

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    fromVersion = typeof o.version === 'number' ? o.version : 0;
    notesRaw = Array.isArray(o.notes) ? o.notes : [];
    if (!Array.isArray(o.notes)) changed = true;
    // `messages` is additive and optional: absent is normal, not a defect.
    if (Array.isArray(o.messages)) messagesRaw = o.messages;
    else if (o.messages !== undefined) changed = true;
  } else if (Array.isArray(input)) {
    // A bare array of notes — be forgiving.
    notesRaw = input;
    changed = true;
  } else {
    changed = true;
  }

  if (fromVersion !== 2) changed = true;

  const notes: Note[] = [];
  for (const raw of notesRaw) {
    if (!raw || typeof raw !== 'object') { changed = true; continue; }
    const r = normalizeNote({ ...(raw as Record<string, unknown>) });
    if (r.changed) changed = true;
    notes.push(r.note);
  }

  const messages: Message[] = [];
  for (const raw of messagesRaw) {
    if (!raw || typeof raw !== 'object') { changed = true; continue; }
    const r = normalizeMessage({ ...(raw as Record<string, unknown>) });
    if (!r) { changed = true; continue; }
    if (r.changed) changed = true;
    messages.push(r.message);
  }

  // Only carry the key when it has content, so an untouched file stays byte-identical.
  const file: NoteFile = messages.length ? { version: 2, notes, messages } : { version: 2, notes };
  return { file, changed, fromVersion };
}
