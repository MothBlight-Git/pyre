/**
 * PYRE — shared types. The file format is the contract between the app, the
 * MCP server, and any agent editing notes.json directly.
 *
 * Copy to: src/shared/types.ts
 */

export type Placement =
  | { mode: 'auto' }
  | { mode: 'manual'; col: number; row: number; pinnedAt: string };

export interface Note {
  /** "n_" + 6 base36 chars. */
  id: string;
  /** As typed. Display uppercases; never mutate the stored casing. */
  topic: string;
  /** Required, non-empty. */
  comment: string;
  /** ISO 8601 UTC, or null for a note with no deadline. */
  due: string | null;
  created: string;
  updated: string;
  done: boolean;
  doneAt: string | null;
  /** Snooze. Damps the fire; NEVER alters `due`. */
  bankedUntil?: string | null;
  /**
   * When banking began. The front freezes at the burn it held at this instant.
   * Set together with `bankedUntil`; cleared together. Falls back to `updated`
   * for records written before this field existed.
   */
  bankedAt?: string | null;
  /**
   * `auto` = the sort owns this note. `manual` = the user dragged it and it
   * holds its cell. This single field is the whole "unless intentionally moved
   * away" rule.
   */
  placement: Placement;
  /** Who created it. Agent notes render a 2px #3A322C tick on the left edge. */
  source: 'user' | 'agent' | string;
}

/**
 * A line in the talk lane — the channel between the user and whatever agent is
 * connected over MCP. The user types `> something` in the bar; an agent reads
 * with `list_messages` and answers with `send_message`.
 *
 * Messages are NOT notes: they carry no deadline, never burn, and never take a
 * grid cell. They live in the same file so the one watcher drives both.
 */
export interface Message {
  /** "m_" + 6 base36 chars. */
  id: string;
  /** Who wrote it. `agent` renders with the same 2px #3A322C provenance tick notes use. */
  role: 'user' | 'agent';
  text: string;
  created: string;
  /** False until the other side has seen it. Drives the unread count. */
  read: boolean;
}

/** The on-disk file. `messages` is optional so a v2 file without it stays valid. */
export interface NoteFile {
  version: 2;
  notes: Note[];
  messages?: Message[];
}

export interface Settings {
  dockSide: 'right' | 'left';
  /** 280–420. Note size is derived from this — see grid.gridMetrics(). */
  railWidth: number;
  alwaysOnTop: boolean;
  reserveScreenSpace: boolean;
  /** "17:00" — applied to any parsed date that carries no explicit time. */
  defaultDueTime: string;
  globalHotkey: string;
  startWithSystem: boolean;
  displayId: number | null;
  /** Local MCP endpoint http://127.0.0.1:<port>/mcp served by the running app. 0 = off. */
  mcpHttpPort: number;
  /** Answer `> …` lines with the built-in assistant when an API key is configured. */
  assistantEnabled: boolean;
  /** Which provider preset answers: anthropic | gemini | openai | openrouter | ollama | custom. */
  assistantProvider: string;
  /** Model the built-in assistant uses. */
  assistantModel: string;
  /** Overrides the preset's base URL. Required for `custom`. */
  assistantBaseUrl: string;
}

/** Everything the renderer can ask the main process to do. */
export interface PyreApi {
  list(): Promise<Note[]>;
  add(input: { topic: string; comment: string; due?: string | null; source?: string }): Promise<Note>;
  update(id: string, patch: Partial<Pick<Note, 'topic' | 'comment' | 'due'>>): Promise<Note>;
  move(id: string, col: number, row: number): Promise<Note>;
  release(id: string): Promise<Note>;
  snuff(id: string): Promise<Note>;
  bank(id: string, until: string): Promise<Note>;
  remove(id: string): Promise<{ ok: true }>;
  settings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Fires whenever notes.json changes — including edits made outside the app. */
  onChange(cb: (notes: Note[]) => void): () => void;
  onWriteError(cb: (message: string) => void): () => void;
}

/** Where the data lives, for the settings sheet and README. */
export interface KeyStatus {
  configured: boolean;
  source: 'stored' | 'env' | 'none';
  encryptionAvailable: boolean;
  hint: string | null;
}

export interface AppInfo {
  version: string;
  dataMode: 'env' | 'portable' | 'installed';
  dataDir: string;
  notesFile: string;
  /** Non-null when a portable location was wanted but unwritable. */
  fellBackFrom: string | null;
  exePath: string;
  /** How this process was started. The single-file portable stub cannot pass stdio through. */
  launcher: 'dev' | 'exe' | 'portable-stub';
  /** Live local MCP endpoint, or null when disabled / failed to bind. */
  mcpHttpUrl: string | null;
  /** Ready-to-paste MCP config snippets. `stdio` is null when the launcher can't serve stdio. */
  mcpConfig: { stdio: string | null; http: string | null };
  displays: Array<{ id: number; label: string; primary: boolean }>;
}

/** The full bridge exposed as window.pyre — PyreApi plus app-level extras. */
export interface PyreBridge extends PyreApi {
  messages(): Promise<Message[]>;
  say(text: string): Promise<Message>;
  markMessagesRead(): Promise<void>;
  clearMessages(): Promise<void>;
  onMessages(cb: (m: Message[]) => void): () => void;
  restore(id: string): Promise<Note>;
  unbank(id: string): Promise<Note>;
  /** Persist layout() corrections without touching pinnedAt. */
  correct(corrections: Array<{ id: string; col: number; row: number }>): Promise<void>;
  info(): Promise<AppInfo>;
  revealData(): Promise<void>;
  resizeRail(width: number): Promise<Settings>;
  quit(): Promise<void>;
  onSettings(cb: (s: Settings) => void): () => void;
  onWriteOk(cb: () => void): () => void;
  /** Global hotkey pressed: focus the composer. */
  onFocusComposer(cb: () => void): () => void;
  /** Tray → Settings… */
  onOpenSettings(cb: () => void): () => void;
  /** API key: the renderer may set, clear and check — never read the key back. */
  keyStatus(provider?: string): Promise<KeyStatus>;
  setKey(provider: string, key: string): Promise<KeyStatus>;
  clearKey(provider: string): Promise<KeyStatus>;
  /** Provider presets for the settings sheet. */
  providers(): Promise<Array<{ id: string; label: string; kind: string; baseUrl?: string; defaultModel: string; needsKey: boolean; hint: string }>>;
  /** One trivial round trip against the configured provider. */
  testAssistant(): Promise<{ ok: boolean; message: string }>;
  /** Grow/shrink the window's inner edge for the visible resize handle. */
  grabZone(open: boolean): Promise<void>;
  /** Signal that a resize handle is held / released. */
  dragging(on: boolean): Promise<void>;
  /** True while the assistant is mid-answer. */
  onAssistantBusy(cb: (busy: boolean) => void): () => void;
}

declare global {
  interface Window { pyre: PyreBridge; }
}
