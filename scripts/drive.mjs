#!/usr/bin/env node
/**
 * DEV ONLY. Client for src/main/debug-driver.ts.
 *   node scripts/drive.mjs shot out.png
 *   node scripts/drive.mjs js "document.title"
 *   node scripts/drive.mjs mouse '[{"type":"mouseMove","x":100,"y":200}]'
 *   node scripts/drive.mjs key '[{"type":"keyDown","keyCode":"Escape"}]'
 *   node scripts/drive.mjs bounds
 * Uses PYRE_DEBUG_DRIVER (default %TEMP%/pyre-driver).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = process.env.PYRE_DEBUG_DRIVER || path.join(os.tmpdir(), 'pyre-driver');
fs.mkdirSync(dir, { recursive: true });
const [type, a, b] = process.argv.slice(2);
const out = path.join(dir, `out-${Date.now()}.${type === 'shot' ? 'png' : 'json'}`);
let cmd;
if (type === 'shot') cmd = { type, out: a ? path.resolve(a) : out, backdrop: b || '#0C0A09' };
else if (type === 'js') cmd = { type, code: a, out };
else if (type === 'mouse' || type === 'key') cmd = { type, events: JSON.parse(a), out };
else if (type === 'bounds') cmd = { type, out };
else { console.error('unknown'); process.exit(2); }
if (fs.existsSync(cmd.out)) fs.unlinkSync(cmd.out);
fs.writeFileSync(path.join(dir, 'cmd.json.tmp'), JSON.stringify(cmd));
fs.renameSync(path.join(dir, 'cmd.json.tmp'), path.join(dir, 'cmd.json'));
const t0 = Date.now();
while (!fs.existsSync(cmd.out)) {
  if (Date.now() - t0 > (Number(b) || 8000)) { console.error('timeout'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 60));
}
await new Promise((r) => setTimeout(r, 40));
if (type === 'shot') console.log(cmd.out);
else console.log(fs.readFileSync(cmd.out, 'utf8'));
