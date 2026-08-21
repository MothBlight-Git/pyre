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
const ABM_WINDOWPOSCHANGED = 0x00000009;
const ABE_LEFT = 0;
const ABE_RIGHT = 2;
const STRUCT_SIZE = 48;

let shell32: { SHAppBarMessage: (msg: number, data: Buffer) => bigint | number } | null = null;
let loadAttempted = false;
let registered = false;
// Last granted reservation in PHYSICAL px, and its edge — the veto's invariant.
let lastGranted: { x: number; width: number } | null = null;
let lastEdge: 'left' | 'right' = 'right';
let settingChangeHooked = false;

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
      log(`appbar: registering hwnd 0x${hwnd.toString(16)}`);
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
    log(`appbar: want ${want.left},${want.top}..${want.right},${want.bottom} query ${qLeft},${qTop}..${qRight},${qBottom}`);
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
    lastGranted = { x: granted.x, width: granted.width };
    lastEdge = side;
    // The shove originates in our own process: Chromium sees WM_SETTINGCHANGE
    // for the work-area change we just caused and "helpfully" relocates the
    // window out of the strip. hookWindowMessage swallows the hooked message
    // before Chromium's handler runs, so while the reservation stands, the
    // work-area change is invisible to it and the move never happens.
    if (!settingChangeHooked) {
      win.hookWindowMessage(WM_SETTINGCHANGE, () => { /* swallowed while reserved */ });
      settingChangeHooked = true;
    }
    log(`appbar: reserved ${granted.width}x${granted.height} at ${granted.x},${granted.y}`);
    return granted;
  } catch (e) {
    log(`appbar: reserve failed (${(e as Error).message})`);
    return null;
  }
}

/** Give the space back. Safe to call when nothing is registered. */
/**
 * The appbar contract (MSDN "Using Application Desktop Toolbars"): after the
 * appbar's window moves or resizes, notify the shell, or it treats the bar's
 * position as stale and may shuffle it — which looked like the window
 * bouncing off its own edge after a resize drag.
 */
export function windowPosChanged(win: BrowserWindow, log: (m: string) => void): void {
  if (!registered || !shell32) return;
  const hwnd = hwndOf(win);
  if (hwnd === null) return;
  try { shell32.SHAppBarMessage(ABM_WINDOWPOSCHANGED, makeData(hwnd, ABE_RIGHT)); }
  catch (e) { log(`appbar: windowposchanged failed (${(e as Error).message})`); }
}

/**
 * The release-bounce, at the root. When our SETPOS shrinks the work area,
 * something — shell cascade or Chromium's own fit-to-work-area — SetWindowPos-es
 * our window out of the strip it just reserved, to exactly x = reserved width.
 * It does not go through Electron's will-move, so it cannot be vetoed there.
 * Native appbars solve this in WM_WINDOWPOSCHANGING: while the veto holds,
 * set SWP_NOMOVE|SWP_NOSIZE in the WINDOWPOS the message carries, and the
 * change never happens. hookWindowMessage runs synchronously in the WndProc,
 * and koffi pokes the flags through the raw pointer.
 */
const WM_WINDOWPOSCHANGING = 0x0046;
const WM_WINDOWPOSCHANGED = 0x0047;
const WM_SETTINGCHANGE = 0x001A;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOSENDCHANGING = 0x0400;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
// WINDOWPOS x64: hwnd(8) hwndInsertAfter(8) x(4) y(4) cx(4) cy(4) flags(4)
const WINDOWPOS_FLAGS_OFFSET = 32;

let memio: { read: (addr: bigint, out: Buffer, n: number) => void; write: (addr: bigint, src: Buffer, n: number) => void } | null = null;
let setWindowPos: ((hwnd: bigint, after: bigint, x: number, y: number, cx: number, cy: number, flags: number) => boolean) | null = null;

function loadMemio(log: (m: string) => void): boolean {
  if (memio) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');
    // RtlMoveMemory both ways; addresses passed as integers.
    const rd = k32.func('__stdcall', 'RtlMoveMemory', 'void', ['void *', 'uintptr_t', 'size_t']);
    const wr = k32.func('__stdcall', 'RtlMoveMemory', 'void', ['uintptr_t', 'void *', 'size_t']);
    memio = {
      read: (addr, out, n) => rd(out, addr, n),
      write: (addr, src, n) => wr(addr, src, n),
    };
    const u32 = koffi.load('user32.dll');
    setWindowPos = u32.func('__stdcall', 'SetWindowPos', 'bool', ['uintptr_t', 'uintptr_t', 'int', 'int', 'int', 'int', 'uint32']);
    return true;
  } catch (e) {
    log(`appbar: move-veto unavailable (${(e as Error).message})`);
    return false;
  }
}

/**
 * While `shouldVeto()` is true, any window move/resize not initiated by our
 * own code is cancelled in place. Install once per window.
 */
/**
 * While a reservation is granted, cancel any WINDOWPOS that would pull the
 * window's OUTER edge off the reserved screen edge — no matter who sends it
 * or when. This closes the reentrancy hole: the shove can arrive while our
 * own setBounds is pumping messages, so an "is this us?" flag loses the race,
 * but a positional invariant cannot. Resizes that keep the outer edge glued
 * (the drag) pass untouched.
 */
export function installMoveVeto(win: BrowserWindow, log: (m: string) => void): void {
  if (!loadMemio(log)) return;
  const scratch = Buffer.alloc(20);
  win.hookWindowMessage(WM_WINDOWPOSCHANGING, (_wParam: Buffer, lParam: Buffer) => {
    if (!registered || !lastGranted) return;
    try {
      const addr = lParam.length >= 8 ? lParam.readBigUInt64LE(0) : BigInt(lParam.readUInt32LE(0));
      if (!addr) return;
      // WINDOWPOS x64: hwnd(8) hwndInsertAfter(8) x(4) y(4) cx(4) cy(4) flags(4)
      memio!.read(addr + 16n, scratch, 20);
      const px = scratch.readInt32LE(0);
      const cx = scratch.readInt32LE(8);
      const flags = scratch.readUInt32LE(16);
      if (flags & SWP_NOMOVE && flags & SWP_NOSIZE) return;
      const wantOuter = lastEdge === 'left' ? lastGranted.x : lastGranted.x + lastGranted.width;
      const proposedOuter = lastEdge === 'left' ? px : px + cx;
      if (Math.abs(proposedOuter - wantOuter) <= 2) return; // glued — allow
      scratch.writeUInt32LE(flags | SWP_NOMOVE | SWP_NOSIZE, 16);
      memio!.write(addr + 32n, scratch.subarray(16, 20), 4);
      log(`appbar: vetoed a move to ${px} (outer ${proposedOuter}, want ${wantOuter})`);
    } catch { /* never break the wndproc */ }
  });

  // The shove is sent with SWP_NOSENDCHANGING, so the cancellable message
  // above never fires for it. WM_WINDOWPOSCHANGED cannot be suppressed;
  // correcting synchronously inside it puts the window back before the
  // frame is presented, so nothing visibly moves.
  const hwnd = hwndOf(win);
  win.hookWindowMessage(WM_WINDOWPOSCHANGED, (_wParam: Buffer, lParam: Buffer) => {
    if (!registered || !lastGranted || !setWindowPos || hwnd === null) return;
    try {
      const addr = lParam.length >= 8 ? lParam.readBigUInt64LE(0) : BigInt(lParam.readUInt32LE(0));
      if (!addr) return;
      memio!.read(addr + 16n, scratch, 20);
      const px = scratch.readInt32LE(0);
      const py = scratch.readInt32LE(4);
      const cx = scratch.readInt32LE(8);
      const cy = scratch.readInt32LE(12);
      const flags = scratch.readUInt32LE(16);
      if (flags & SWP_NOMOVE) return; // position untouched — not the shove
      const wantOuter = lastEdge === 'left' ? lastGranted.x : lastGranted.x + lastGranted.width;
      const isOuter = lastEdge === 'left' ? px : px + cx;
      if (Math.abs(isOuter - wantOuter) <= 2) return;
      const fixedX = lastEdge === 'left' ? lastGranted.x : lastGranted.x + lastGranted.width - cx;
      setWindowPos(hwnd, 0n, fixedX, py, cx, cy, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
      log(`appbar: corrected a landed shove (${px} -> ${fixedX})`);
    } catch { /* never break the wndproc */ }
  });
}

/**
 * Position the window at an EXACT physical rect. Electron's setBounds speaks
 * DIPs; on a 2.86x display the round trip can land 1-2 physical px wide of
 * the granted strip, and a 1px straddle across the work-area boundary makes
 * the shell clamp the window fully inside it — the bounce, sometimes, on
 * some widths, which is exactly the maddening pattern this had.
 */
export function setPhysicalBounds(win: BrowserWindow, r: AppBarRect, log: (m: string) => void): void {
  if (!loadMemio(log) || !setWindowPos) return;
  const hwnd = hwndOf(win);
  if (hwnd === null) return;
  setWindowPos(hwnd, 0n, r.x, r.y, r.width, r.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
}

export function release(win: BrowserWindow, log: (m: string) => void): void {
  if (settingChangeHooked) { try { win.unhookWindowMessage(WM_SETTINGCHANGE); } catch { /* gone */ } settingChangeHooked = false; }
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
export function clearGranted(): void { lastGranted = null; }
