/**
 * PYRE main process. App lifecycle, global hotkey, tray, and the --mcp branch.
 *
 * `Pyre.exe --mcp` must never create a BrowserWindow. Electron has already
 * booted as Electron by the time this file runs, so ELECTRON_RUN_AS_NODE can't
 * retro-actively apply to *this* process; instead we re-spawn ourselves with it
 * set, stdio inherited, and the child runs the stdio MCP server as plain Node.
 * One binary, both modes, no Node on the host.
 */
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(1);
const wantsMcp = argv.includes('--mcp');

if (wantsMcp) {
  runMcpParent();
} else {
  runApp();
}

// ------------------------------------------------------------------ --mcp

function runMcpParent(): void {
  const { app } = require('electron') as typeof import('electron');
  // Keep Chromium quiet and out of the way; no window, no GPU.
  app.disableHardwareAcceleration();
  const serverEntry = path.join(__dirname, '..', 'mcp', 'server.js');
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (app.isPackaged) env.PYRE_EXE_DIR = exeDirForChild();
  const child = spawn(process.execPath, [serverEntry], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => { process.stderr.write(`pyre --mcp: ${e.message}\n`); process.exit(1); });
  const forward = () => { try { child.kill(); } catch { /* ignore */ } };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  // Prevent Electron from exiting before the child (it would with no windows).
  app.on('window-all-closed', () => { /* stay alive */ });
}

/** The child runs as Node and can't ask Electron where the exe is; pass it. */
function exeDirForChild(): string {
  return process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(process.execPath);
}

// ------------------------------------------------------------------ app

function runApp(): void {
  const electron = require('electron') as typeof import('electron');
  const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, screen } = electron;
  const { resolvePaths } = require('./paths') as typeof import('./paths');
  const { Store } = require('./store') as typeof import('./store');
  const { createRailWindow, applyBounds, railBoundsOnMonitor, rendererEntry } = require('./window') as typeof import('./window');
  const { registerIpc, wireStoreEvents } = require('./ipc') as typeof import('./ipc');
  const { emberIcon } = require('./icon') as typeof import('./icon');
  const { startMcpHttp } = require('./mcp-http') as typeof import('./mcp-http');
  const appbar = require('./appbar') as typeof import('./appbar');
  const { Agent } = require('./agent') as typeof import('./agent');
  const secrets = require('./secrets') as typeof import('./secrets');

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  const log = (m: string) => { if (process.env.PYRE_DEBUG) console.log(`[pyre] ${m}`); };
  const paths = resolvePaths();
  const store = new Store(paths, log);
  let win: InstanceType<typeof BrowserWindow> | null = null;
  let tray: InstanceType<typeof Tray> | null = null;
  let hotkey = '';
  let mcpHttp: import('./mcp-http').McpHttp | null = null;

  // The built-in assistant. Reads the key lazily so Settings changes take effect
  // without a restart; does nothing at all when no key is configured.
  const { preset } = require('./providers') as typeof import('./providers');
  const agentConfig = (): import('./agent').AgentConfig => {
    const s = store.settings();
    const p = preset(s.assistantProvider);
    return {
      providerId: p.id,
      model: s.assistantModel || p.defaultModel,
      baseUrl: s.assistantBaseUrl || p.baseUrl,
      apiKey: secrets.getKey(paths.dir, p.id, log),
    };
  };
  const agent = new Agent(store, agentConfig, log);
  const send = (channel: string, ...args: unknown[]) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };
  /**
   * Answer any unread user message in the talk lane. Fires for messages typed in
   * the bar AND for ones written straight into notes.json, since both land as a
   * store 'messages' event. Agent replies are role 'agent', so this cannot loop.
   */
  const maybeRespond = () => {
    const s = store.settings();
    if (!s.assistantEnabled || agent.isBusy()) return;
    if (!store.messages().some((x) => x.role === 'user' && !x.read)) return;
    const cfg = agentConfig();
    // No key on a provider that needs one: an external MCP agent owns the lane.
    if (preset(cfg.providerId).needsKey && !cfg.apiKey) return;
    send('agent:busy', true);
    void agent.respond().finally(() => send('agent:busy', false));
  };

  const restartMcpHttp = async (port: number) => {
    if (mcpHttp) { mcpHttp.close(); mcpHttp = null; }
    mcpHttp = await startMcpHttp(store, port, log);
  };

  const focusComposer = () => {
    if (!win) return;
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.send('app:focusComposer');
  };

  const registerHotkey = (accel: string) => {
    if (hotkey) { try { globalShortcut.unregister(hotkey); } catch { /* ignore */ } }
    hotkey = '';
    try {
      if (globalShortcut.register(accel, focusComposer)) hotkey = accel;
      else log(`hotkey ${accel} could not be registered`);
    } catch (e) {
      log(`hotkey error: ${(e as Error).message}`);
    }
  };

  const applySettings = (s: import('../shared/types').Settings, prev: import('../shared/types').Settings) => {
    if (!win) return;
    if (s.alwaysOnTop !== prev.alwaysOnTop) win.setAlwaysOnTop(s.alwaysOnTop, 'floating');
    if (s.globalHotkey !== prev.globalHotkey) registerHotkey(s.globalHotkey);
    if (s.startWithSystem !== prev.startWithSystem) {
      app.setLoginItemSettings({ openAtLogin: s.startWithSystem, path: process.execPath });
    }
    if (s.mcpHttpPort !== prev.mcpHttpPort) void restartMcpHttp(s.mcpHttpPort);
    applyBounds(win, s);
    applyReserve(s);
  };

  /**
   * Keep the AppBar registration in step with the setting, the dock side and
   * the width. Windows can hand back a different rect than we asked for, in
   * which case the window moves to what we were actually given.
   */
  const applyReserve = (s: import('../shared/types').Settings) => {
    if (!win) return;
    if (!s.reserveScreenSpace) {
      if (appbar.isReserved()) { appbar.release(win, log); applyBounds(win, s); }
      return;
    }
    // Two conversions matter here:
    //  - the rect MUST be the monitor rect, not railBounds() (see railBoundsOnMonitor)
    //  - SHAppBarMessage is Win32, so it wants PHYSICAL pixels, while Electron's
    //    screen/setBounds APIs speak DIPs. On a scaled display those differ, and
    //    passing DIPs makes the rect miss the screen edge, so Windows quietly
    //    reserves nothing.
    const wantDip = railBoundsOnMonitor(s);
    const wantPx = screen.dipToScreenRect(win, wantDip);
    const grantedPx = appbar.reserve(win, s.dockSide, wantPx, log);
    if (grantedPx) win.setBounds(screen.screenToDipRect(win, grantedPx));
  };

  app.on('second-instance', () => focusComposer());

  app.whenReady().then(() => {
    store.load();
    store.watch();

    const preload = path.join(__dirname, '..', 'preload', 'index.js');
    win = createRailWindow(store.settings(), preload);
    const entry = rendererEntry();
    if ('url' in entry) win.loadURL(entry.url); else win.loadFile(entry.file);
    win.on('closed', () => { win = null; });

    registerIpc({
      store, getWindow: () => win, applySettings,
      mcpHttpUrl: () => mcpHttp?.url ?? null,
      onKeyChanged: () => maybeRespond(),
    });
    store.on('messages', () => maybeRespond());
    wireStoreEvents(store, () => win);
    registerHotkey(store.settings().globalHotkey);
    void restartMcpHttp(store.settings().mcpHttpPort);
    // After the window exists and is shown, claim screen space if asked.
    win.once('ready-to-show', () => applyReserve(store.settings()));

    // Re-dock on display changes.
    const redock = () => { if (win) { applyBounds(win, store.settings()); applyReserve(store.settings()); } };
    screen.on('display-metrics-changed', redock);
    screen.on('display-added', redock);
    screen.on('display-removed', redock);

    // Tray
    const icon = nativeImage.createFromBuffer(emberIcon(32)).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Pyre');
    const rebuildMenu = () => {
      const s = store.settings();
      tray!.setContextMenu(Menu.buildFromTemplate([
        { label: 'New note  (' + s.globalHotkey.replace(/Control/g, 'Ctrl') + ')', click: focusComposer },
        { type: 'separator' },
        { label: 'Always on top', type: 'checkbox', checked: s.alwaysOnTop,
          click: (mi) => { const prev = store.settings(); applySettings(store.setSettings({ alwaysOnTop: mi.checked }), prev); } },
        { label: 'Dock left', type: 'radio', checked: s.dockSide === 'left',
          click: () => { const prev = store.settings(); applySettings(store.setSettings({ dockSide: 'left' }), prev); } },
        { label: 'Dock right', type: 'radio', checked: s.dockSide === 'right',
          click: () => { const prev = store.settings(); applySettings(store.setSettings({ dockSide: 'right' }), prev); } },
        { type: 'separator' },
        { label: 'Open data folder', click: () => { electron.shell.openPath(store.paths.dir); } },
        { label: 'Settings…', click: () => { win?.show(); win?.webContents.send('app:openSettings'); } },
        { type: 'separator' },
        { label: 'Quit Pyre', click: () => app.quit() },
      ]));
    };
    rebuildMenu();
    store.on('settings', rebuildMenu);
    tray.on('click', () => { win?.show(); win?.focus(); });

    if (process.env.PYRE_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
    if (process.env.PYRE_DEBUG_DRIVER) {
      const { installDebugDriver } = require('./debug-driver') as typeof import('./debug-driver');
      installDebugDriver(process.env.PYRE_DEBUG_DRIVER, () => win);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    store.unwatch();
    mcpHttp?.close();
    // Hand the reserved strip back, or every other window keeps avoiding it.
    if (win) appbar.release(win, log);
  });
}
