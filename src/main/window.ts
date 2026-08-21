/**
 * The rail window: frameless, transparent, always-on-top, skip-taskbar,
 * full work-area height, flush to the dock edge. Width 280–420, persisted.
 */
import { BrowserWindow, screen, type Display } from 'electron';
import * as path from 'node:path';
import type { Settings } from '../shared/types';

export const MIN_RAIL = 280;
export const MAX_RAIL = 420;
/**
 * Extra transparent strip on the rail's INNER edge while Settings is open, so
 * the resize handle can float visually outside the rail — past the AppBar
 * reservation, over whatever is next to it. The reservation itself never
 * includes it; only the window bounds grow.
 */
export const GRAB_PX = 24;

export function pickDisplay(displayId: number | null): Display {
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
}

export function railBounds(s: Settings): { x: number; y: number; width: number; height: number } {
  const d = pickDisplay(s.displayId);
  const wa = d.workArea;
  const width = Math.max(MIN_RAIL, Math.min(MAX_RAIL, s.railWidth));
  const x = s.dockSide === 'left' ? wa.x : wa.x + wa.width - width;
  return { x, y: wa.y, width, height: wa.height };
}

/**
 * The rail against the FULL monitor rectangle, ignoring the work area.
 *
 * This is what an AppBar reservation must be computed from. `railBounds()`
 * derives from `workArea`, which already excludes any space we ourselves
 * reserved — feeding that back into a reservation walks the window across the
 * screen a rail-width at a time on every settings change. Windows trims this
 * rect for other appbars (the taskbar) during ABM_QUERYPOS.
 */
export function railBoundsOnMonitor(s: Settings): { x: number; y: number; width: number; height: number } {
  const d = pickDisplay(s.displayId);
  const b = d.bounds;
  const width = Math.max(MIN_RAIL, Math.min(MAX_RAIL, s.railWidth));
  const x = s.dockSide === 'left' ? b.x : b.x + b.width - width;
  return { x, y: b.y, width, height: b.height };
}

export function createRailWindow(s: Settings, preload: string): BrowserWindow {
  const b = railBounds(s);
  const win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    // WS_EX_TOOLWINDOW. Tool windows are exempt from the shell's
    // keep-inside-the-work-area repositioning — without this, every AppBar
    // SETPOS shoves the window out of its own freshly reserved strip by
    // exactly the reserved width (the release "bounce"). This is the fix
    // native appbars use (FixedToolWindow); the wndproc veto stays as backup.
    type: 'toolbar',
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: s.alwaysOnTop,
    skipTaskbar: true,
    resizable: false, // transparent windows can't edge-resize on Windows; the renderer has its own handle
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Pyre',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false, // the fire must keep ticking while unfocused
    },
  });
  if (s.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  return win;
}

/**
 * Re-dock the window: full width/height/position from the chosen display.
 * Use when the dock side, display or reservation changes.
 */
export function applyBounds(win: BrowserWindow, s: Settings, extra = 0): void {
  win.setBounds(expandInner(railBounds(s), s, extra));
}

/** Grow a rail rect by `extra` DIPs on its inner edge (the side facing the desktop). */
export function expandInner(
  b: { x: number; y: number; width: number; height: number }, s: Settings, extra: number,
): { x: number; y: number; width: number; height: number } {
  if (!extra) return b;
  return s.dockSide === 'right'
    ? { x: b.x - extra, y: b.y, width: b.width + extra, height: b.height }
    : { x: b.x, y: b.y, width: b.width + extra, height: b.height };
}

/**
 * Width-only change: grow from the anchored edge and leave everything else
 * alone.
 *
 * The rail can be moved with its drag strip, so re-docking on every resize
 * teleports a window the user deliberately placed. Instead we hold the edge the
 * dock side implies — the right edge when docked right — and move the other
 * one, then clamp back inside the work area so it can never end up off-screen.
 */
export function applyWidth(win: BrowserWindow, s: Settings, extra = 0, clamp = true): void {
  // The window is the rail plus any grab allowance; both are recomputed from
  // scratch each call, so toggling the allowance on and off cannot drift.
  const width = Math.max(MIN_RAIL, Math.min(MAX_RAIL, s.railWidth)) + extra;
  const b = win.getBounds();

  let x = s.dockSide === 'left' ? b.x : b.x + b.width - width;
  // Never let the outer edge leave the work area — EXCEPT while our own
  // AppBar reservation is active. The work area excludes that reservation,
  // so clamping against it would throw the window out of its own strip;
  // the caller passes clamp=false and the reserve path re-docks at rest.
  if (clamp) {
    const wa = pickDisplay(s.displayId).workArea;
    x = s.dockSide === 'left'
      ? Math.max(wa.x, x)
      : Math.min(x, wa.x + wa.width - width);
  }

  win.setBounds({ x, y: b.y, width, height: b.height });
}

export function rendererEntry(): { file: string } | { url: string } {
  const devUrl = process.env.PYRE_DEV_URL;
  if (devUrl) return { url: devUrl };
  return { file: path.join(__dirname, '..', 'renderer', 'index.html') };
}
