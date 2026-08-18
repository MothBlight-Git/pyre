/**
 * notes.json + settings.json store (CLAUDE.md §5).
 *
 *  - Atomic writes: write `notes.json.tmp`, fsync, rename.
 *  - fs.watch on the directory (a file watch dies on Windows after rename),
 *    debounced 150ms, self-write suppression via a write token + mtime + a
 *    content hash fallback.
 *  - On write failure: hold in memory, emit `writeError`, retry every 10s.
 *
 * Every mutation the app or the MCP server can perform lives here so both
 * paths share atomicity, the watcher and the exact same semantics.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { Note, NoteFile, Settings, Placement, Message } from '../shared/types';
import { migrate } from '../shared/migrate';
import type { ResolvedPaths } from './paths';

export const DEFAULT_SETTINGS: Settings = {
  dockSide: 'right',
  railWidth: 340,
  alwaysOnTop: true,
  reserveScreenSpace: false,
  defaultDueTime: '17:00',
  globalHotkey: 'Control+Alt+N',
  startWithSystem: false,
  displayId: null,
  mcpHttpPort: 41777,
};

export const WRITE_ERROR_COPY =
  "Can't write to notes.json. Your last note is held in memory. Check file permissions.";

export function newId(prefix = 'n_'): string {
  let s = '';
  while (s.length < 6) s += Math.random().toString(36).slice(2);
  return prefix + s.slice(0, 6);
}

/** Talk lane is a conversation, not an archive — keep the tail bounded. */
export const MAX_MESSAGES = 200;

const nowIso = () => new Date().toISOString();

export interface StoreEvents {
  change: (notes: Note[]) => void;
  writeError: (message: string) => void;
  writeOk: () => void;
  settings: (s: Settings) => void;
}

export class Store extends EventEmitter {
  private file: NoteFile = { version: 2, notes: [] };
  private settingsCache: Settings = { ...DEFAULT_SETTINGS };
  private lastWrittenHash = '';
  private lastWrittenMtimeMs = 0;
  private writeToken = 0;
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pendingWrite = false;
  private writeFailing = false;
  private log: (msg: string) => void;

  constructor(public readonly paths: ResolvedPaths, log: (msg: string) => void = () => {}) {
    super();
    this.log = log;
  }

  // ---------------------------------------------------------------- loading

  /** Read from disk, migrate if needed (writing once + backing up v1). */
  load(): Note[] {
    fs.mkdirSync(this.paths.dir, { recursive: true });
    let raw: unknown = null;
    let text: string | null = null;
    if (fs.existsSync(this.paths.notesFile)) {
      text = fs.readFileSync(this.paths.notesFile, 'utf8');
      try {
        raw = text.trim() ? JSON.parse(text) : { version: 2, notes: [] };
      } catch (e) {
        // Corrupt JSON: keep whatever we had in memory, back the file up, don't overwrite silently.
        this.log(`notes.json is not valid JSON: ${(e as Error).message}`);
        this.backup('notes.corrupt.bak.json', text);
        raw = { version: 2, notes: this.file.notes };
      }
    } else {
      raw = { version: 2, notes: [] };
    }

    const result = migrate(raw);
    this.file = result.file;
    if (text !== null) this.lastWrittenHash = hash(text);

    // First run: materialise the file so the documented path exists for agents to find.
    if (result.changed || text === null) {
      if (result.fromVersion === 1 && text !== null) this.backup('notes.v1.bak.json', text);
      this.write();
    }
    this.loadSettings();
    return this.notes();
  }

  private backup(name: string, text: string) {
    try {
      const target = path.join(this.paths.dir, name);
      if (!fs.existsSync(target)) fs.writeFileSync(target, text);
    } catch (e) {
      this.log(`backup failed: ${(e as Error).message}`);
    }
  }

  /** Re-read the file if it changed on disk (used by the MCP process, which has no watcher). */
  reload(): Note[] {
    if (!fs.existsSync(this.paths.notesFile)) return this.notes();
    const text = fs.readFileSync(this.paths.notesFile, 'utf8');
    const h = hash(text);
    if (h === this.lastWrittenHash) return this.notes();
    try {
      const raw = text.trim() ? JSON.parse(text) : { version: 2, notes: [] };
      const result = migrate(raw);
      this.file = result.file;
      this.lastWrittenHash = h;
      if (result.changed) this.write();
    } catch (e) {
      this.log(`ignoring unparsable notes.json: ${(e as Error).message}`);
    }
    return this.notes();
  }

  // ---------------------------------------------------------------- reading

  notes(): Note[] {
    return this.file.notes.map((n) => ({ ...n, placement: { ...n.placement } }));
  }

  get(id: string): Note | undefined {
    return this.file.notes.find((n) => n.id === id);
  }

  // ---------------------------------------------------------------- writing

  private serialize(): string {
    return JSON.stringify(this.file, null, 2) + '\n';
  }

  /** Atomic write. Returns true on success. Emits change on success. */
  write(): boolean {
    const text = this.serialize();
    const tmp = this.paths.notesFile + '.tmp';
    const token = ++this.writeToken;
    try {
      fs.mkdirSync(this.paths.dir, { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.paths.notesFile);
      const st = fs.statSync(this.paths.notesFile);
      if (token === this.writeToken) {
        this.lastWrittenHash = hash(text);
        this.lastWrittenMtimeMs = st.mtimeMs;
      }
      this.pendingWrite = false;
      if (this.writeFailing) {
        this.writeFailing = false;
        this.emit('writeOk');
      }
      this.stopRetry();
      this.emit('change', this.notes());
      this.emit('messages', this.messages());
      return true;
    } catch (e) {
      this.log(`write failed: ${(e as Error).message}`);
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
      this.pendingWrite = true;
      this.writeFailing = true;
      this.emit('writeError', WRITE_ERROR_COPY);
      this.emit('change', this.notes()); // in-memory state still updates the grid
      this.emit('messages', this.messages());
      this.startRetry();
      return false;
    }
  }

  private startRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (this.pendingWrite) this.write();
      else this.stopRetry();
    }, 10_000);
  }
  private stopRetry() {
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
  }

  // ---------------------------------------------------------------- watching

  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.paths.dir, { persistent: false }, (_ev, filename) => {
        const name = filename ? String(filename) : '';
        if (name && name !== 'notes.json' && name !== 'settings.json') return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.onExternalChange(name || 'notes.json'), 150);
      });
      this.watcher.on('error', (e) => this.log(`watch error: ${(e as Error).message}`));
    } catch (e) {
      this.log(`fs.watch unavailable: ${(e as Error).message}`);
    }
  }

  unwatch(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.stopRetry();
  }

  private onExternalChange(name: string) {
    if (name === 'settings.json') {
      const before = JSON.stringify(this.settingsCache);
      this.loadSettings();
      if (JSON.stringify(this.settingsCache) !== before) this.emit('settings', this.settings());
      return;
    }
    let text: string;
    let st: fs.Stats;
    try {
      st = fs.statSync(this.paths.notesFile);
      text = fs.readFileSync(this.paths.notesFile, 'utf8');
    } catch {
      return; // mid-rename or deleted; the next event will catch it
    }
    // Self-write suppression: same mtime as our last write, or identical content.
    if (st.mtimeMs === this.lastWrittenMtimeMs) return;
    const h = hash(text);
    if (h === this.lastWrittenHash) return;

    let raw: unknown;
    try {
      raw = text.trim() ? JSON.parse(text) : { version: 2, notes: [] };
    } catch {
      // Half-written by an editor; wait for the next event.
      return;
    }
    const result = migrate(raw);
    this.file = result.file;
    this.lastWrittenHash = h;
    this.lastWrittenMtimeMs = st.mtimeMs;
    this.log('external change picked up');
    if (result.changed) this.write(); // repairs a hand-edited record; emits change
    else { this.emit('change', this.notes()); this.emit('messages', this.messages()); }
  }

  // ---------------------------------------------------------------- settings

  private loadSettings() {
    try {
      if (fs.existsSync(this.paths.settingsFile)) {
        const raw = JSON.parse(fs.readFileSync(this.paths.settingsFile, 'utf8'));
        this.settingsCache = sanitizeSettings({ ...DEFAULT_SETTINGS, ...raw });
      }
    } catch (e) {
      this.log(`settings.json unreadable: ${(e as Error).message}`);
    }
  }

  settings(): Settings {
    return { ...this.settingsCache };
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.settingsCache = sanitizeSettings({ ...this.settingsCache, ...patch });
    try {
      const tmp = this.paths.settingsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.settingsCache, null, 2) + '\n');
      fs.renameSync(tmp, this.paths.settingsFile);
    } catch (e) {
      this.log(`settings write failed: ${(e as Error).message}`);
    }
    this.emit('settings', this.settings());
    return this.settings();
  }

  // ---------------------------------------------------------------- mutations

  add(input: { topic: string; comment: string; due?: string | null; source?: string; placement?: Placement }): Note {
    const ts = nowIso();
    const note: Note = {
      id: newId(),
      topic: input.topic ?? '',
      comment: input.comment ?? '',
      due: input.due ?? null,
      created: ts,
      updated: ts,
      done: false,
      doneAt: null,
      bankedUntil: null,
      bankedAt: null,
      placement: input.placement ?? { mode: 'auto' },
      source: input.source ?? 'user',
    };
    if (!note.topic.trim()) note.topic = 'UNSORTED';
    this.file.notes.push(note);
    this.write();
    return { ...note };
  }

  private mutate(id: string, fn: (n: Note) => void): Note {
    const n = this.file.notes.find((x) => x.id === id);
    if (!n) throw new Error(`No note with id ${id}`);
    fn(n);
    n.updated = nowIso();
    this.write();
    return { ...n };
  }

  update(id: string, patch: Partial<Pick<Note, 'topic' | 'comment' | 'due'>>): Note {
    return this.mutate(id, (n) => {
      if (patch.topic !== undefined) n.topic = patch.topic.trim() ? patch.topic : 'UNSORTED';
      if (patch.comment !== undefined) n.comment = patch.comment;
      if (patch.due !== undefined) n.due = patch.due;
    });
  }

  move(id: string, col: number, row: number): Note {
    return this.mutate(id, (n) => {
      n.placement = { mode: 'manual', col: Math.max(0, col | 0), row: Math.max(0, row | 0), pinnedAt: nowIso() };
    });
  }

  /** Correct a pin's stored slot without touching pinnedAt (layout() corrections). */
  correct(corrections: Array<{ id: string; col: number; row: number }>): void {
    let touched = false;
    for (const c of corrections) {
      const n = this.file.notes.find((x) => x.id === c.id);
      if (!n || n.placement.mode !== 'manual') continue;
      if (n.placement.col === c.col && n.placement.row === c.row) continue;
      n.placement = { ...n.placement, col: c.col, row: c.row };
      touched = true;
    }
    if (touched) this.write();
  }

  release(id: string): Note {
    return this.mutate(id, (n) => { n.placement = { mode: 'auto' }; });
  }

  snuff(id: string): Note {
    return this.mutate(id, (n) => { n.done = true; n.doneAt = nowIso(); });
  }

  restore(id: string): Note {
    return this.mutate(id, (n) => { n.done = false; n.doneAt = null; });
  }

  bank(id: string, until: string): Note {
    if (Number.isNaN(Date.parse(until))) throw new Error('bank: `until` must be an ISO date');
    return this.mutate(id, (n) => { n.bankedUntil = until; n.bankedAt = nowIso(); });
  }

  unbank(id: string): Note {
    return this.mutate(id, (n) => { n.bankedUntil = null; n.bankedAt = null; });
  }

  // ------------------------------------------------------------ talk lane

  messages(): Message[] {
    return (this.file.messages ?? []).map((m) => ({ ...m }));
  }

  /**
   * Append a line to the lane. `read: false` means the OTHER side hasn't seen
   * it — a user message is unread by the agent, and vice versa.
   */
  say(role: 'user' | 'agent', text: string): Message {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('message text is required');
    const msg: Message = { id: newId('m_'), role, text: body, created: nowIso(), read: false };
    const list = this.file.messages ?? (this.file.messages = []);
    list.push(msg);
    if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
    this.write();
    return { ...msg };
  }

  /** Mark everything from `role` as seen. */
  markRead(role: 'user' | 'agent'): void {
    let touched = false;
    for (const m of this.file.messages ?? []) {
      if (m.role === role && !m.read) { m.read = true; touched = true; }
    }
    if (touched) this.write();
  }

  clearMessages(): void {
    if (!this.file.messages?.length) return;
    delete this.file.messages;
    this.write();
  }

  remove(id: string): { ok: true } {
    const i = this.file.notes.findIndex((x) => x.id === id);
    if (i === -1) throw new Error(`No note with id ${id}`);
    this.file.notes.splice(i, 1);
    this.write();
    return { ok: true };
  }
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export function sanitizeSettings(s: Settings): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS, ...s };
  out.dockSide = out.dockSide === 'left' ? 'left' : 'right';
  out.railWidth = Math.max(280, Math.min(420, Math.round(Number(out.railWidth) || 340)));
  out.alwaysOnTop = !!out.alwaysOnTop;
  out.reserveScreenSpace = !!out.reserveScreenSpace;
  out.startWithSystem = !!out.startWithSystem;
  if (!/^\d{1,2}:\d{2}$/.test(String(out.defaultDueTime))) out.defaultDueTime = '17:00';
  if (typeof out.globalHotkey !== 'string' || !out.globalHotkey) out.globalHotkey = DEFAULT_SETTINGS.globalHotkey;
  out.displayId = typeof out.displayId === 'number' ? out.displayId : null;
  const port = Math.round(Number(out.mcpHttpPort));
  out.mcpHttpPort = Number.isFinite(port) && port >= 0 && port <= 65535 ? port : DEFAULT_SETTINGS.mcpHttpPort;
  return out;
}
