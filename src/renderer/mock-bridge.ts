/**
 * DEV ONLY. When the renderer runs outside Electron (vite dev server / a plain
 * browser) there is no preload and no window.pyre. This installs an in-memory
 * bridge with the same contract so the whole UI can be exercised and visually
 * checked against note-example.html. Never used in the packaged app.
 */
import type { Note, Settings, PyreBridge, AppInfo, Placement, Message, KeyStatus } from '../shared/types';

const mockKey = (configured: boolean): KeyStatus => ({
  configured,
  source: configured ? 'stored' : 'none',
  encryptionAvailable: true,
  hint: configured ? '••••1234' : null,
});

export function installMockBridge(): void {
  if (window.pyre) return;
  document.documentElement.dataset.mock = '';
  const now = Date.now();
  const iso = (m: number) => new Date(now + m * 60000).toISOString();
  const mk = (id: string, topic: string, comment: string, dueMin: number | null, extra: Partial<Note> = {}): Note => ({
    id, topic, comment, due: dueMin === null ? null : iso(dueMin),
    created: new Date(now - Math.random() * 1e7).toISOString(), updated: new Date().toISOString(),
    done: false, doneAt: null, bankedUntil: null, bankedAt: null, placement: { mode: 'auto' }, source: 'user', ...extra,
  });
  const q = new URLSearchParams(location.search);
  let notes: Note[] = q.has('empty') ? [] : [
    mk('n_cold01', 'READING', 'Look up ISO 19650 naming', null),
    mk('n_warm01', 'INVOICE', 'Submit August hours', 8 * 60),
    mk('n_due001', 'INVOICE', 'Submit August hours', 60),
    mk('n_burn01', 'INVOICE', 'Submit August hours', 30),
    mk('n_crit01', 'WINWATER', 'Call Powell about the BEP', 6),
    mk('n_over01', 'WINWATER', 'Send BEP to Powell', -2 * 1440),
    mk('n_bank01', 'INVOICE', 'Submit August hours', 60, { bankedUntil: iso(90), bankedAt: new Date(now - 30 * 60000).toISOString() }),
    mk('n_gone01', 'WINWATER', 'Send BEP to Powell', -21 * 1440),
    mk('n_agent1', 'AGENT', 'Added by an agent', null, { source: 'agent' }),
    mk('n_pin001', 'PINNED', 'Cold but pinned at top-left', null, { placement: { mode: 'manual', col: 0, row: 0, pinnedAt: '2026-08-10T00:00:00Z' } }),
    mk('n_done01', 'DONE', 'Already snuffed', null, { done: true, doneAt: new Date(now - 3600e3).toISOString() }),
  ];
  let settings: Settings = {
    dockSide: 'right', railWidth: +(q.get('w') ?? 340), alwaysOnTop: true, reserveScreenSpace: false,
    defaultDueTime: '17:00', globalHotkey: 'Control+Alt+N', startWithSystem: false, displayId: null, mcpHttpPort: 41777,
    assistantEnabled: true, assistantProvider: 'anthropic', assistantModel: 'claude-opus-5', assistantBaseUrl: '',
  };
  let messages: Message[] = q.has('msgs') ? [
    { id: 'm_1', role: 'user', text: 'move winwater to friday please', created: new Date(now - 6 * 60000).toISOString(), read: true },
    { id: 'm_2', role: 'agent', text: 'Moved WINWATER to Fri 21 Aug 17:00 and left it on auto placement.', created: new Date(now - 5 * 60000).toISOString(), read: false },
  ] : [];
  const listeners = { change: new Set<(n: Note[]) => void>(), settings: new Set<(s: Settings) => void>(), err: new Set<(m: string) => void>(), ok: new Set<() => void>(), focus: new Set<() => void>(), open: new Set<() => void>(), msgs: new Set<(m: Message[]) => void>(), busy: new Set<(b: boolean) => void>() };
  const emit = () => { const copy = notes.map((n) => ({ ...n })); for (const cb of listeners.change) cb(copy); };
  const emitMsgs = () => { const copy = messages.map((m) => ({ ...m })); for (const cb of listeners.msgs) cb(copy); };
  const find = (id: string) => { const n = notes.find((x) => x.id === id); if (!n) throw new Error('no note ' + id); return n; };
  const touch = (n: Note) => { n.updated = new Date().toISOString(); emit(); return { ...n }; };
  const on = <T,>(set: Set<T>) => (cb: T) => { set.add(cb); return () => set.delete(cb); };
  const applyRail = () => { document.documentElement.style.setProperty('--mock-rail', settings.railWidth + 'px'); };
  applyRail();

  const bridge: PyreBridge = {
    list: async () => notes.map((n) => ({ ...n })),
    add: async (input) => {
      const n = mk('n_' + Math.random().toString(36).slice(2, 8), input.topic, input.comment, null, { source: input.source ?? 'user' });
      n.due = input.due ?? null;
      notes.push(n); emit(); return { ...n };
    },
    update: async (id, patch) => touch(Object.assign(find(id), patch)),
    move: async (id, col, row) => { const n = find(id); n.placement = { mode: 'manual', col, row, pinnedAt: new Date().toISOString() }; return touch(n); },
    release: async (id) => { const n = find(id); n.placement = { mode: 'auto' } as Placement; return touch(n); },
    snuff: async (id) => { const n = find(id); n.done = true; n.doneAt = new Date().toISOString(); return touch(n); },
    restore: async (id) => { const n = find(id); n.done = false; n.doneAt = null; return touch(n); },
    bank: async (id, until) => { const n = find(id); n.bankedUntil = until; n.bankedAt = new Date().toISOString(); return touch(n); },
    unbank: async (id) => { const n = find(id); n.bankedUntil = null; n.bankedAt = null; return touch(n); },
    remove: async (id) => { notes = notes.filter((n) => n.id !== id); emit(); return { ok: true }; },
    correct: async (c) => { for (const x of c) { const n = notes.find((y) => y.id === x.id); if (n && n.placement.mode === 'manual') n.placement = { ...n.placement, col: x.col, row: x.row }; } },
    messages: async () => messages.map((m) => ({ ...m })),
    say: async (text: string) => {
      const m: Message = { id: 'm_' + Math.random().toString(36).slice(2, 8), role: 'user', text, created: new Date().toISOString(), read: false };
      messages.push(m); emitMsgs();
      // Mock only: a canned reply so the lane can be exercised without an agent.
      window.setTimeout(() => {
        messages.push({ id: 'm_' + Math.random().toString(36).slice(2, 8), role: 'agent', text: 'Mock reply to: ' + text, created: new Date().toISOString(), read: false });
        messages = messages.map((x) => x.role === 'user' ? { ...x, read: true } : x);
        emitMsgs();
      }, 1200);
      return { ...m };
    },
    markMessagesRead: async () => { messages = messages.map((m) => m.role === 'agent' ? { ...m, read: true } : m); emitMsgs(); },
    clearMessages: async () => { messages = []; emitMsgs(); },
    onMessages: on(listeners.msgs),
    settings: async () => ({ ...settings }),
    setSettings: async (patch) => { settings = { ...settings, ...patch }; applyRail(); for (const cb of listeners.settings) cb({ ...settings }); return { ...settings }; },
    resizeRail: async (w) => bridge.setSettings({ railWidth: w }),
    info: async (): Promise<AppInfo> => ({
      version: 'dev', dataMode: 'env', dataDir: 'C:\\mock', notesFile: 'C:\\mock\\notes.json', fellBackFrom: q.has('fallback') ? 'E:\\Pyre\\pyre-data' : null,
      exePath: 'C:\\mock\\Pyre.exe',
      launcher: q.has('stub') ? 'portable-stub' : 'exe',
      mcpHttpUrl: 'http://127.0.0.1:41777/mcp',
      mcpConfig: {
        stdio: q.has('stub') ? null : JSON.stringify({ mcpServers: { pyre: { command: 'C:\\mock\\Pyre.exe', args: ['--mcp'] } } }, null, 2),
        http: JSON.stringify({ mcpServers: { pyre: { url: 'http://127.0.0.1:41777/mcp' } } }, null, 2),
      },
      displays: [{ id: 1, label: 'Display 1', primary: true }],
    }),
    revealData: async () => {},
    quit: async () => {},
    onChange: on(listeners.change),
    onWriteError: on(listeners.err),
    onWriteOk: on(listeners.ok),
    onSettings: on(listeners.settings),
    onFocusComposer: on(listeners.focus),
    onOpenSettings: on(listeners.open),
    keyStatus: async () => mockKey(q.has('key')),
    setKey: async () => mockKey(true),
    clearKey: async () => mockKey(false),
    onAssistantBusy: on(listeners.busy),
    testAssistant: async () => ({ ok: true, message: 'mock provider answered, and supports tools.' }),
    grabZone: async () => {},
    dragging: async () => {},
    providers: async () => [
      { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', defaultModel: 'claude-opus-5', needsKey: true, hint: 'Key from console.anthropic.com' },
      { id: 'gemini', label: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.5-flash', needsKey: true, hint: 'Key from aistudio.google.com/apikey' },
      { id: 'ollama', label: 'Ollama (local)', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.1', needsKey: false, hint: 'Runs on this machine. No key, no bill.' },
    ],
  };
  window.pyre = bridge;
  // Debug hooks for the browser console.
  (window as unknown as { __mock: unknown }).__mock = {
    writeError: (m = "Can't write to notes.json. Your last note is held in memory. Check file permissions.") => listeners.err.forEach((cb) => cb(m)),
    writeOk: () => listeners.ok.forEach((cb) => cb()),
    setDue: (id: string, min: number | null) => { const n = find(id); n.due = min === null ? null : iso(min); emit(); },
    notes: () => notes,
  };
}
