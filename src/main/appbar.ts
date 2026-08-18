/**
 * `reserveScreenSpace` — register the rail as a Windows **AppBar** so maximised
 * windows stop underneath it instead of behind it, the way the taskbar behaves.
 *
 * Electron has no API for this; it needs SHAppBarMessage from shell32, reached
 * through koffi. Everything here is defensive on purpose: if the FFI cannot
 * load, if the struct layout is wrong, if the call fails — we log and carry on
 * with the setting simply not taking effect. Reserving screen space is a nicety;
 * it must never be able to stop the app from starting.
 *
 * Windows-only. On any other platform every function is a no-op.
 *
 * APPBARDATA (x64):
 *   DWORD  cbSize          0
 *   HWND   hWnd            8   (8-aligned)
 *   UINT   uCallbackMessage 16
 *   UINT   uEdge           20
 *   RECT   rc              24  (4 LONGs = 16 bytes)
 *   LPARAM lParam          40
 *   total                  48
 */
import type { BrowserWindow } from 'electron';

const ABM_NEW = 0x00000000;
const ABM_REMOVE = 0x00000001;
const ABM_QUERYPOS = 0x00000002;
const ABM_SETPOS = 0x00000003;
const ABE_LEFT = 0;
const ABE_RIGHT = 2;
const STRUCT_SIZE = 48;

let shell32: { SHAppBarMessage: (msg: number, data: Buffer) => bigint | number } | null = null;
let loadAttempted = false;
let registered = false;

function load(log: (m: string) => void): boolean {
  if (process.platform !== 'win32') return false;
  if (loadAttempted) return shell32 !== null;
  loadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const lib = koffi.load('shell32.dll');
    shell32 = {
      SHAppBarMessage: lib.func('__stdcall', 'SHAppBarMessage', 'uintptr_t', ['uint32', 'void *']),
    };
    return true;
  } catch (e) {
    log(`appbar: FFI unavailable, reserveScreenSpace will do nothing (${(e as Error).message})`);
    shell32 = null;
    return false;
  }
}

/** HWND out of Electron's native handle buffer (LE, 8 bytes on x64). */
function hwndOf(win: BrowserWindow): bigint | null {
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigUInt64LE(0);
    if (buf.length >= 4) return BigInt(buf.readUInt32LE(0));
    return null;
  } catch {
    return null;
  }
}

function makeData(hwnd: bigint, edge: number, rect?: { left: number; top: number; right: number; bottom: number }): Buffer {
  const b = Buffer.alloc(STRUCT_SIZE);
  b.writeUInt32LE(STRUCT_SIZE, 0);
  b.writeBigUInt64LE(hwnd, 8);
  b.writeUInt32LE(0, 16);        // uCallbackMessage — we register no callback
  b.writeUInt32LE(edge, 20);
  if (rect) {
    b.writeInt32LE(rect.left, 24);
    b.writeInt32LE(rect.top, 28);
    b.writeInt32LE(rect.right, 32);
    b.writeInt32LE(rect.bottom, 36);
  }
  return b;
}

export interface AppBarRect { x: number; y: number; width: number; height: number }

/**
 * Claim `rect` on `side`. Windows may hand back a different rect (another
 * appbar is already there); the caller should move the window to what comes
 * back. Returns the granted rect, or null if nothing was reserved.
 */
export function reserve(
  win: BrowserWindow,
  side: 'left' | 'right',
  rect: AppBarRect,
  log: (m: string) => void,
): AppBarRect | null {
  if (!load(log)) return null;
  const hwnd = hwndOf(win);
  if (hwnd === null) { log('appbar: no native window handle'); return null; }
  const edge = side === 'left' ? ABE_LEFT : ABE_RIGHT;

  try {
    if (!registered) {
      const nw = makeData(hwnd, edge);
      const ok = shell32!.SHAppBarMessage(ABM_NEW, nw);
      if (!ok) { log('appbar: ABM_NEW refused'); return null; }
      registered = true;
    }

    // Ask Windows where it will actually let us sit, then commit to that.
    const want = { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
    const q = makeData(hwnd, edge, want);
    shell32!.SHAppBarMessage(ABM_QUERYPOS, q);

    // QUERYPOS adjusts the edge we asked for; keep our width against it.
    const qLeft = q.readInt32LE(24), qTop = q.readInt32LE(28);
    const qRight = q.readInt32LE(32), qBottom = q.readInt32LE(36);
    const final = side === 'right'
      ? { left: qRight - rect.width, top: qTop, right: qRight, bottom: qBottom }
      : { left: qLeft, top: qTop, right: qLeft + rect.width, bottom: qBottom };

    const s = makeData(hwnd, edge, final);
    shell32!.SHAppBarMessage(ABM_SETPOS, s);
    const granted = {
      x: s.readInt32LE(24),
      y: s.readInt32LE(28),
      width: s.readInt32LE(32) - s.readInt32LE(24),
      height: s.readInt32LE(36) - s.readInt32LE(28),
    };
    if (granted.width <= 0 || granted.height <= 0) { log('appbar: got an empty rect back'); return null; }
    log(`appbar: reserved ${granted.width}x${granted.height} at ${granted.x},${granted.y}`);
    return granted;
  } catch (e) {
    log(`appbar: reserve failed (${(e as Error).message})`);
    return null;
  }
}

/** Give the space back. Safe to call when nothing is registered. */
export function release(win: BrowserWindow, log: (m: string) => void): void {
  if (!registered || !shell32) { registered = false; return; }
  try {
    const hwnd = hwndOf(win);
    if (hwnd !== null) shell32.SHAppBarMessage(ABM_REMOVE, makeData(hwnd, ABE_RIGHT));
    log('appbar: released');
  } catch (e) {
    log(`appbar: release failed (${(e as Error).message})`);
  } finally {
    registered = false;
  }
}

export function isReserved(): boolean { return registered; }
