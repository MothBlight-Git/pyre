/**
 * Overlay sheets inside the rail window: the Done archive and Settings.
 * Soot on the desktop, bone type, no chroma.
 */
import type { Note, Settings, AppInfo } from '../shared/types';
import { displayTopic } from '../shared/parse';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class Sheets {
  private open: HTMLElement | null = null;

  constructor(
    private archive: HTMLElement,
    private archiveList: HTMLElement,
    private settings: HTMLElement,
    private settingsBody: HTMLElement,
    private onClose: () => void,
  ) {
    for (const s of [archive, settings]) {
      s.querySelector('[data-close]')?.addEventListener('click', () => this.close());
    }
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.open) { ev.preventDefault(); this.close(); }
    });
  }

  isOpen(): boolean { return !!this.open; }

  close(): void {
    if (!this.open) return;
    this.open.hidden = true;
    this.open = null;
    this.onClose();
  }

  toggleArchive(all: () => Note[]): void {
    if (this.open === this.archive) return this.close();
    this.close();
    this.renderArchive(all());
    this.archive.hidden = false;
    this.open = this.archive;
    (this.archive.querySelector('button') as HTMLElement | null)?.focus();
  }

  renderArchive(all: Note[]): void {
    const done = all.filter((n) => n.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')).slice(0, 50);
    this.archiveList.replaceChildren();
    if (!done.length) {
      this.archiveList.appendChild(h('p', 'sheet__empty', 'Nothing snuffed yet.'));
      return;
    }
    for (const n of done) {
      const row = h('div', 'arch');
      row.appendChild(h('span', 'arch__topic', displayTopic(n.topic)));
      row.appendChild(h('span', 'arch__when', n.doneAt ? relative(n.doneAt) : ''));
      row.appendChild(h('span', 'arch__comment', n.comment));
      const restore = h('button', 'meta-btn arch__restore', 'RESTORE');
      restore.type = 'button';
      restore.addEventListener('click', async () => {
        await window.pyre.restore(n.id);
        this.renderArchive((await window.pyre.list()));
      });
      row.appendChild(restore);
      this.archiveList.appendChild(row);
    }
  }

  async toggleSettings(): Promise<void> {
    if (this.open === this.settings) return this.close();
    this.close();
    await this.renderSettings();
    this.settings.hidden = false;
    this.open = this.settings;
  }

  async renderSettings(): Promise<void> {
    const [s, info] = await Promise.all([window.pyre.settings(), window.pyre.info()]);
    const body = this.settingsBody;
    body.replaceChildren();

    const row = (label: string, ctl: HTMLElement) => {
      const r = h('div', 'set');
      r.appendChild(h('span', 'set__label', label));
      const c = h('span', 'set__ctl');
      c.appendChild(ctl);
      r.appendChild(c);
      body.appendChild(r);
    };
    const toggle = (on: boolean, fn: (v: boolean) => void, disabled = false) => {
      const b = h('button', 'toggle', on ? 'ON' : 'OFF');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.disabled = disabled;
      b.addEventListener('click', () => {
        const v = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(v)); b.textContent = v ? 'ON' : 'OFF'; fn(v);
      });
      return b;
    };
    const set = (patch: Partial<Settings>) => window.pyre.setSettings(patch);

    // Dock side
    const seg = h('span', 'seg');
    for (const side of ['left', 'right'] as const) {
      const b = h('button', undefined, side.toUpperCase());
      b.type = 'button';
      b.setAttribute('aria-pressed', String(s.dockSide === side));
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        void set({ dockSide: side });
      });
      seg.appendChild(b);
    }
    row('Dock side', seg);

    // Rail width
    const wWrap = h('span', 'set__ctl');
    const range = h('input');
    range.type = 'range'; range.min = '280'; range.max = '420'; range.step = '2'; range.value = String(s.railWidth);
    const val = h('span', 'set__val', `${s.railWidth}px`);
    range.addEventListener('input', () => { val.textContent = `${range.value}px`; void window.pyre.resizeRail(+range.value); });
    wWrap.append(range, val);
    row('Rail width', wWrap);

    row('Always on top', toggle(s.alwaysOnTop, (v) => void set({ alwaysOnTop: v })));

    // Default due time
    const time = h('input');
    time.type = 'time'; time.value = s.defaultDueTime;
    time.addEventListener('change', () => { if (time.value) void set({ defaultDueTime: time.value }); });
    row('Default due time', time);

    // Hotkey
    const hk = h('input');
    hk.type = 'text'; hk.value = s.globalHotkey; hk.size = 16; hk.spellcheck = false;
    hk.addEventListener('change', () => { if (hk.value.trim()) void set({ globalHotkey: hk.value.trim() }); });
    row('Global hotkey', hk);

    row('Start with system', toggle(s.startWithSystem, (v) => void set({ startWithSystem: v })));
    row('Reserve screen space', toggle(s.reserveScreenSpace, (v) => void set({ reserveScreenSpace: v })));

    // Display
    if (info.displays.length > 1) {
      const sel = h('select');
      for (const d of info.displays) {
        const o = h('option', undefined, d.label + (d.primary ? ' · primary' : ''));
        o.value = String(d.id);
        if ((s.displayId ?? info.displays.find((x) => x.primary)?.id) === d.id) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => void set({ displayId: +sel.value }));
      row('Display', sel);
    }

    // Data location
    {
      const blk = h('div', 'set__block');
      blk.appendChild(h('span', 'set__label', `Data · ${info.dataMode}`));
      blk.appendChild(h('div', 'set__path', info.notesFile));
      if (info.fellBackFrom) {
        blk.appendChild(h('p', 'set__note is-warn',
          `Wanted to write beside the executable (${info.fellBackFrom}) but that location is not writable. Using the home folder instead.`));
      }
      const reveal = h('button', 'meta-btn', 'REVEAL FOLDER');
      reveal.type = 'button';
      reveal.addEventListener('click', () => void window.pyre.revealData());
      blk.appendChild(reveal);
      body.appendChild(blk);
    }

    // AI access
    {
      const copyBtn = (label: string, textToCopy: string) => {
        const b = h('button', 'meta-btn', label);
        b.type = 'button';
        b.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(textToCopy); b.textContent = 'COPIED'; }
          catch { b.textContent = 'SELECT + CTRL+C'; }
          window.setTimeout(() => { b.textContent = label; }, 1400);
        });
        return b;
      };

      const rsNote = h('p', 'set__note', 'Reserve screen space registers the rail as a Windows AppBar, so maximised windows stop at its edge instead of hiding behind it.');
      body.appendChild(rsNote);

      const blk = h('div', 'set__block');
      blk.appendChild(h('span', 'set__label', 'AI access'));
      blk.appendChild(h('p', 'set__note',
        'Any agent that can read and write notes.json sees the wall update live — the path is above. Two MCP transports are built in:'));

      // 1. Local HTTP endpoint (works from every build while the app runs)
      const portRow = h('div', 'set');
      portRow.appendChild(h('span', 'set__label', 'Local MCP endpoint'));
      const pc = h('span', 'set__ctl');
      const port = h('input');
      port.type = 'text'; port.value = String(s.mcpHttpPort); port.size = 6; port.inputMode = 'numeric';
      port.title = 'Port for http://127.0.0.1:<port>/mcp · 0 = off';
      port.addEventListener('change', () => {
        const v = Math.max(0, Math.min(65535, Math.round(Number(port.value) || 0)));
        port.value = String(v);
        void set({ mcpHttpPort: v }).then(() => window.setTimeout(() => void this.renderSettings(), 300));
      });
      pc.appendChild(port);
      portRow.appendChild(pc);
      blk.appendChild(portRow);
      if (info.mcpConfig.http) {
        blk.appendChild(h('p', 'set__note', `Streamable HTTP, running now (Cursor · Claude Code · any HTTP MCP client). Live while the rail is open.`));
        blk.appendChild(h('code', 'set__code', info.mcpConfig.http));
        blk.appendChild(copyBtn('COPY HTTP CONFIG', info.mcpConfig.http));
      } else if (s.mcpHttpPort) {
        blk.appendChild(h('p', 'set__note is-warn', `Could not listen on port ${s.mcpHttpPort} — is something else using it? Change the port above.`));
      } else {
        blk.appendChild(h('p', 'set__note', 'Off. Set a port (41777 is the default) to enable.'));
      }

      // 2. stdio (Pyre.exe --mcp) — not possible through the single-file portable stub
      blk.appendChild(h('span', 'set__label', 'stdio · Pyre.exe --mcp')).style.marginTop = '10px';
      if (info.mcpConfig.stdio) {
        blk.appendChild(h('p', 'set__note', 'For Claude Desktop (stdio only) and anything else that launches a command. Works even when the rail is closed.'));
        blk.appendChild(h('code', 'set__code', info.mcpConfig.stdio));
        blk.appendChild(copyBtn('COPY STDIO CONFIG', info.mcpConfig.stdio));
      } else {
        blk.appendChild(h('p', 'set__note is-warn',
          'You are running the single-file portable Pyre.exe. Its launcher extracts and starts the real app without passing stdio through, so `Pyre.exe --mcp` cannot answer a stdio client. Use the local HTTP endpoint above (Cursor, Claude Code), or the folder/installer build for Claude Desktop.'));
      }

      blk.appendChild(h('p', 'set__note',
        'Where it goes — Claude Desktop: claude_desktop_config.json (stdio). Cursor: .cursor/mcp.json in a project or ~/.cursor/mcp.json (either transport). Claude Code: claude mcp add --transport http pyre <url>, or claude mcp add pyre -- "<Pyre.exe>" --mcp.'));
      body.appendChild(blk);
    }

    body.appendChild(h('p', 'set__note', `Pyre ${info.version}`));
  }
}

function relative(iso: string): string {
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
