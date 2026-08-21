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
  const { createRailWindow, applyBounds, applyWidth, railBoundsOnMonitor, expandInner, GRAB_PX, rendererEntry } = require('./window') as typeof import('./window');
  const { registerIpc, wireStoreEvents } = require('./ipc') as typeof import('./ipc');
  const { emberIcon } = require('./icon') as typeof import('./icon');
  const { startMcpHttp } = require('./mcp-http') as typeof import('./mcp-http');
  const appbar = require('./appbar') as typeof import('./appbar');
  const { Agent, testProvider } = require('./agent') as typeof import('./agent');
  const secrets = require('./secrets') as typeof import('./secrets');

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  const log = (m: string) => { if (process.env.PYRE_DEBUG) console.log(`[pyre] ${m}`); };
  // While Settings is open the window carries a transparent GRAB_PX strip on
  // its inner edge for the resize handle. Never part of the AppBar reservation.
  let grabZone = false;
  const grabExtra = () => (grabZone ? GRAB_PX : 0);
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
    // A width-only change grows from the anchored edge; anything that changes
    // where the rail belongs re-docks it properly.
    const redocks = s.dockSide !== prev.dockSide || s.displayId !== prev.displayId
      || s.reserveScreenSpace !== prev.reserveScreenSpace;
    // Real AppBars (the taskbar) do not renegotiate their reservation on
    // every tick of a drag — they move the window live and commit the
    // reservation once at rest. Doing SETPOS + snap-to-granted per tick made
    // the window visibly fight its own reservation under a real mouse drag
    // (~60 commits/s, each with DIP↔physical rounding jitter).
    if (redocks) {
      // The invariant pins the OLD edge; drop it before moving to the new one,
      // or the veto cancels our own re-dock.
      appbar.clearGranted();
      ourWrite(() => applyBounds(win!, s, grabExtra()));
      applyReserve(s);
    } else if (appbar.isReserved()) {
      // Mid-drag: move the window only. The reservation follows at rest —
      // a SETPOS mid-drag makes the shell's cascade evaluate a moving window
      // against a fresh boundary, and any 1px overlap gets clamped (jumpy).
      ourWrite(() => applyWidth(win!, s, grabExtra(), false));
      scheduleReserve();
    } else {
      applyWidth(win, s, grabExtra());
      applyReserve(s);
    }
  };

  /**
   * Keep the AppBar registration in step with the setting, the dock side and
   * the width. Windows can hand back a different rect than we asked for, in
   * which case the window moves to what we were actually given.
   */
  // Trailing debounce for reservation updates during a live resize. 250ms of
  // stillness is the "at rest" signal; the final applyReserve then does the
  // one SETPOS + granted-rect snap.
  let reserveTimer: NodeJS.Timeout | null = null;
  // While the user's hand is on a resize handle, the reservation must not
  // move at all: a reservation update mid-drag makes Chromium see a window
  // straddling the new work-area boundary and clamp it inside — the bounce.
  // Only after release, when the window equals the rect we are about to
  // reserve, is it safe to renegotiate.
  // While a hand is on the handle, hold all reservation updates; renegotiate
  // once at release, when the window is still and can be fitted exactly.
  let dragging = false;
  let reservePending = false;
  const scheduleReserve = () => {
    if (dragging) { reservePending = true; return; }
    if (reserveTimer) clearTimeout(reserveTimer);
    reserveTimer = setTimeout(() => { reserveTimer = null; applyReserve(store.settings()); }, 250);
  };
  const setDragging = (on: boolean) => {
    dragging = on;
    if (!on && reservePending) {
      reservePending = false;
      if (reserveTimer) clearTimeout(reserveTimer);
      reserveTimer = setTimeout(() => { reserveTimer = null; applyReserve(store.settings()); }, 80);
    }
  };

  // Where the window belongs while reserved. If anything else moves it — the
  // shell shuffling an appbar it thinks is stale, another app, Windows itself —
  // snap it back. Skipped mid-drag (reserveTimer pending), so it never fights
  // the user's hand.
  let expectedBounds: Electron.Rectangle | null = null;
  // True while WE are calling setBounds, so the veto below can tell our own
  // geometry writes from the shell's.
  let selfMove = false;
  const ourWrite = (fn: () => void) => { selfMove = true; try { fn(); } finally { selfMove = false; } };
  let snapTimer: NodeJS.Timeout | null = null;
  const snapBack = () => {
    if (!win || !expectedBounds || reserveTimer) return;
    const b = win.getBounds();
    const e = expectedBounds;
    if (Math.abs(b.x - e.x) <= 1 && Math.abs(b.width - e.width) <= 1) return;
    log(`appbar: window strayed to ${b.x},${b.width}w — snapping back to ${e.x},${e.width}w`);
    ourWrite(() => win!.setBounds(e));
    appbar.windowPosChanged(win, log);
  };

  const applyReserve = (s: import('../shared/types').Settings) => {
    if (!win) return;
    if (!s.reserveScreenSpace) {
      if (appbar.isReserved()) { appbar.release(win, log); appbar.clearGranted(); expectedBounds = null; ourWrite(() => applyBounds(win!, s, grabExtra())); }
      return;
    }
    // Two conversions matter here:
    //  - the rect MUST be the monitor rect, not railBounds() (see railBoundsOnMonitor)
    //  - SHAppBarMessage is Win32, so it wants PHYSICAL pixels, while Electron's
    //    screen/setBounds APIs speak DIPs. On a scaled display those differ, and
    //    passing DIPs makes the rect miss the screen edge, so Windows quietly
    //    reserves nothing.
    // The reservation must cover the WHOLE window, grab allowance included.
    // Empirically, a window even 24px wider than its own reservation gets
    // shoved out of the strip by the shell on every SETPOS; window == strip
    // is left alone. The handle still floats over what looks like desktop —
    // reservations are invisible — but nothing ever fights.
    const wantDip = expandInner(railBoundsOnMonitor(s), s, grabExtra());
    const wantPx = screen.dipToScreenRect(win, wantDip);
    const grantedPx = appbar.reserve(win, s.dockSide, wantPx, log);
    // The reservation is the rail alone; the window may be wider by the grab
    // allowance, which floats past the reserved edge over whatever is there.
    if (grantedPx) {
      // Granted already includes the allowance; the window IS the strip.
      // EXACT physical fit — a DIP-rounded setBounds can straddle the new
      // work-area boundary by 1-2 physical px, and any straddle gets clamped.
      expectedBounds = screen.screenToDipRect(win, grantedPx);
      ourWrite(() => appbar.setPhysicalBounds(win!, grantedPx, log));
      // Contract step most samples forget: tell the shell the bar moved.
      appbar.windowPosChanged(win, log);
    }
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
    // Self-healing: whoever moves the reserved window, it goes back where the
    // reservation says it belongs, shortly after the dust settles.
    const queueSnap = () => {
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = setTimeout(() => { snapTimer = null; snapBack(); }, 120);
    };
    // THE fix for the release bounce: when our SETPOS shrinks the work area,
    // something SetWindowPos-es our window out of the strip it just reserved,
    // to exactly x = reserved width — and it does not pass through Electron's
    // will-move, so it is cancelled at the wndproc instead (appbar.ts). The
    // snap guard below stays as a fallback for anything that slips through.
    appbar.installMoveVeto(win, log);
    win.on('moved', queueSnap);
    win.on('resized', queueSnap);
    // Diagnosis: every actual bounds change, timestamped, so a visible bounce
    // can be matched to whichever code path caused it.
    win.on('move', () => { const b = win!.getBounds(); log(`bounds ${Date.now() % 100000} ${b.x},${b.y} ${b.width}x${b.height}`); });
    win.on('resize', () => { const b = win!.getBounds(); log(`bounds ${Date.now() % 100000} ${b.x},${b.y} ${b.width}x${b.height}`); });

    registerIpc({
      store, getWindow: () => win, applySettings,
      mcpHttpUrl: () => mcpHttp?.url ?? null,
      onKeyChanged: () => maybeRespond(),
      testAssistant: () => testProvider(agentConfig()),
      setDragging,
      setGrabZone: (open: boolean) => {
        if (grabZone === open || !win) return;
        grabZone = open;
        const s2 = store.settings();
        if (appbar.isReserved() && s2.reserveScreenSpace) {
          if (reserveTimer) { clearTimeout(reserveTimer); reserveTimer = null; }
          applyReserve(s2); // atomic: new strip and window land together
        } else {
          applySettings(s2, s2);
        }
      },
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
