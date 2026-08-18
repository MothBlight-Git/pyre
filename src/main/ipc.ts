/**
 * PyreBridge handlers. Every renderer request goes through here to the Store.
 */
import { app, ipcMain, shell, BrowserWindow, screen } from 'electron';
import type { Store } from './store';
import type { Settings, AppInfo } from '../shared/types';
import { mcpConfigSnippets, detectLauncher } from './mcp-config';

export interface IpcHost {
  store: Store;
  getWindow: () => BrowserWindow | null;
  applySettings: (s: Settings, prev: Settings) => void;
  /** Live local MCP endpoint URL, or null. */
  mcpHttpUrl: () => string | null;
}

export function registerIpc(host: IpcHost): void {
  const { store } = host;
  const h = <T>(channel: string, fn: (...args: any[]) => T | Promise<T>) =>
    ipcMain.handle(channel, (_e, ...args) => fn(...args));

  h('notes:list', () => store.notes());
  h('notes:add', (input) => store.add(input));
  h('notes:update', (id, patch) => store.update(id, patch));
  h('notes:move', (id, col, row) => store.move(id, col, row));
  h('notes:release', (id) => store.release(id));
  h('notes:snuff', (id) => store.snuff(id));
  h('notes:restore', (id) => store.restore(id));
  h('notes:bank', (id, until) => store.bank(id, until));
  h('notes:unbank', (id) => store.unbank(id));
  h('notes:remove', (id) => store.remove(id));
  h('notes:correct', (corrections) => { store.correct(corrections); });

  h('settings:get', () => store.settings());
  h('settings:set', (patch: Partial<Settings>) => {
    const prev = store.settings();
    const next = store.setSettings(patch);
    host.applySettings(next, prev);
    return next;
  });
  h('rail:resize', (width: number) => {
    const prev = store.settings();
    const next = store.setSettings({ railWidth: width });
    host.applySettings(next, prev);
    return next;
  });

  h('app:info', (): AppInfo => {
    const p = store.paths;
    const exePath = process.execPath;
    const launcher = detectLauncher(app.isPackaged);
    const mcpHttpUrl = host.mcpHttpUrl();
    return {
      version: app.getVersion(),
      dataMode: p.mode,
      dataDir: p.dir,
      notesFile: p.notesFile,
      fellBackFrom: p.fellBackFrom,
      exePath,
      launcher,
      mcpHttpUrl,
      mcpConfig: mcpConfigSnippets(exePath, launcher, mcpHttpUrl),
      displays: screen.getAllDisplays().map((d, i) => ({
        id: d.id,
        label: d.label || `Display ${i + 1} (${d.size.width}×${d.size.height})`,
        primary: d.id === screen.getPrimaryDisplay().id,
      })),
    };
  });
  h('app:reveal', async () => { await shell.openPath(store.paths.dir); });
  h('app:quit', () => { app.quit(); });
}

/** Push events from main → renderer. */
export function wireStoreEvents(store: Store, getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, ...args: unknown[]) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  };
  store.on('change', (notes) => send('notes:changed', notes));
  store.on('writeError', (msg) => send('notes:writeError', msg));
  store.on('writeOk', () => send('notes:writeOk'));
  store.on('settings', (s) => send('settings:changed', s));
}
