/**
 * The rail window: frameless, transparent, always-on-top, skip-taskbar,
 * full work-area height, flush to the dock edge. Width 280–420, persisted.
 */
import { BrowserWindow, screen, type Display } from 'electron';
import * as path from 'node:path';
import type { Settings } from '../shared/types';

export const MIN_RAIL = 280;
export const MAX_RAIL = 420;

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

export function createRailWindow(s: Settings, preload: string): BrowserWindow {
  const b = railBounds(s);
  const win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
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

export function applyBounds(win: BrowserWindow, s: Settings): void {
  win.setBounds(railBounds(s));
}

export function rendererEntry(): { file: string } | { url: string } {
  const devUrl = process.env.PYRE_DEV_URL;
  if (devUrl) return { url: devUrl };
  return { file: path.join(__dirname, '..', 'renderer', 'index.html') };
}
