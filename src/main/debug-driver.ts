/**
 * DEV ONLY. Enabled by PYRE_DEBUG_DRIVER=<dir>. Polls <dir>/cmd.json and
 * executes it against the rail window, so the build can be exercised and
 * screenshotted without a human at the desk. Never active in a packaged app
 * unless the env var is set explicitly.
 *
 *   { "type": "shot", "out": "path.png" }
 *   { "type": "js",   "code": "...", "out": "path.json" }
 *   { "type": "mouse", "events": [{type:'mouseDown'|'mouseMove'|'mouseUp', x, y, button?}], "out": "path.json" }
 *   { "type": "key",  "events": [{type:'keyDown'|'keyUp'|'char', keyCode, modifiers?}], "out": "path.json" }
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';

export function installDebugDriver(dir: string, getWindow: () => BrowserWindow | null): void {
  fs.mkdirSync(dir, { recursive: true });
  const cmdFile = path.join(dir, 'cmd.json');
  let busy = false;
  setInterval(async () => {
    if (busy || !fs.existsSync(cmdFile)) return;
    busy = true;
    let cmd: any;
    try {
      cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
      fs.unlinkSync(cmdFile);
    } catch { busy = false; return; }
    const win = getWindow();
    const done = (result: unknown) => {
      if (cmd.out) fs.writeFileSync(cmd.out, typeof result === 'string' ? result : JSON.stringify(result ?? null));
    };
    try {
      if (!win) throw new Error('no window');
      if (cmd.type === 'shot') {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(cmd.out, img.toPNG());
      } else if (cmd.type === 'js') {
        const r = await win.webContents.executeJavaScript(cmd.code, true);
        done(r);
      } else if (cmd.type === 'mouse') {
        for (const e of cmd.events) {
          win.webContents.sendInputEvent({ type: e.type, x: e.x, y: e.y, button: e.button ?? 'left', clickCount: e.clickCount ?? 1, movementX: 0, movementY: 0 } as any);
          if (e.wait) await new Promise((r) => setTimeout(r, e.wait));
        }
        done({ ok: true });
      } else if (cmd.type === 'key') {
        for (const e of cmd.events) {
          win.webContents.sendInputEvent({ type: e.type, keyCode: e.keyCode, modifiers: e.modifiers ?? [] } as any);
          if (e.wait) await new Promise((r) => setTimeout(r, e.wait));
        }
        done({ ok: true });
      } else if (cmd.type === 'bounds') {
        done(win.getBounds());
      } else {
        done({ error: 'unknown cmd' });
      }
    } catch (e) {
      done({ error: String((e as Error).message ?? e) });
    } finally {
      busy = false;
    }
  }, 200);
}
