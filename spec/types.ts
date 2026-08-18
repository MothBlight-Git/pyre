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
   * `auto` = the sort owns this note. `manual` = the user dragged it and it
   * holds its cell. This single field is the whole "unless intentionally moved
   * away" rule.
   */
  placement: Placement;
  /** Who created it. Agent notes render a 2px #3A322C tick on the left edge. */
  source: 'user' | 'agent' | string;
}

/** The on-disk file. */
export interface NoteFile {
  version: 2;
  notes: Note[];
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
