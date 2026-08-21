# Pyre — burning desktop notes

A frameless, transparent, always-on-top rail of square paper notes on the edge of your monitor. A note with a deadline **burns away from its bottom edge in the last two hours**. Drag notes anywhere; burning ones claim the top-left unless you moved them yourself. Everything is readable and writable by an AI agent. One portable `Pyre.exe`.

Build contract: [`CLAUDE.md`](CLAUDE.md). Design files: [`reference/`](reference/).

---

## Run it

**Portable:** put `Pyre.exe` anywhere and double-click it. No install, no admin. To keep the data beside the exe (USB stick, synced folder), create an empty file named `pyre.portable` next to it — or just create a `pyre-data/` folder next to it.

**Installed:** `Pyre-Setup-x.y.z.exe` adds a Start Menu entry. Data lives in `%USERPROFILE%\.stickyburn\`.

**From source:**

```bash
npm install
npm test          # 63 tests: burn curve, grid, parser, talk lane, store, MCP stdio + HTTP end-to-end
npm start         # build + launch
npm run dist      # release/Pyre.exe (single-file portable) · Pyre-Setup-*.exe (installer) · Pyre-*-win.zip (portable folder)
```

## Use it

Type into the entry box: **`topic / comment / due`** then `Enter`.

- `winwater / send BEP to Powell / fri 9am`
- `/ just a thought` → files under UNSORTED
- Due forms: `today` `tonight` `tomorrow` `fri` `3d` `2w` `4h` `8/21` `2026-08-21` `8/21 3pm` `fri 9am` `3pm`. Default time 17:00 (settings).
- Three chips preview the parse live. The due chip always shows the **resolved date**, never what you typed. If the last segment isn't a date it stays part of the comment.
- **Talk lane.** A line starting with `>` is a message to the connected agent rather than a note: `> move winwater to friday`. It appears in a lane under the composer, the agent reads it with `list_messages` and answers with `send_message`. `>` outranks everything, so a message may contain slashes freely.
- **Bar commands.** A line with no `/` reading `quit` (or `exit`) closes the app — the chip row swaps to a single `QUIT PYRE` chip so you can see what Enter will do before you commit to it. Anything containing a `/` is always a note, so `/ quit` still files a note.

| Action | Mouse | Keyboard (note focused) |
|---|---|---|
| Mark done (snuff) | hover → ✓ | `Ctrl+Enter` |
| Edit in place | hover → ✎ | `Enter` |
| Bank 2h / rest of day (snooze — never changes the due date) | hover → ◐ / `Shift`+click | `B` / `Shift+B` (again to un-bank) |
| Release a pinned note back to auto | hover → ⇱ | `R` |
| Delete | hover → ✕ | `Delete` |
| Move (pin) | drag it | — |
| Cancel a drag | `Esc` | |
| New note from anywhere | | `Ctrl+Alt+N` (global) |
| Done archive / Settings | `DONE` / `SETTINGS` under the entry box | `Ctrl+,` for settings |
| Resize the rail (280–420) | drag its inner edge, or the slider in Settings | |
| Move the window | drag the invisible 28px strip along its top | |
| **Quit** | tray icon → Quit Pyre | type `quit` or `exit` in the bar → Enter |
| **Talk to the agent** | `TALK` button opens the lane | type `> your message` in the bar → Enter |

**Placement rule.** Auto notes sort by heat (hottest top-left), then dated above undated, then newest. A note you dragged holds its cell forever — a fire will flow *around* it, never evict it. If a pinned note catches fire below the fold, an ember pip appears bottom-right; click it to scroll there.

**States.** cold · warming (due set, > 2h out; the firelight ramps over the last 24h) · due · burning · critical · overdue · gone-out (> 7 days overdue) · banked.

## Where the data is

One JSON file, resolved in this order (first hit wins):

1. `PYRE_DATA` environment variable → that folder
2. `pyre.portable` marker beside the exe → `.\pyre-data\`
3. `.\pyre-data\` beside the exe already exists and is writable → portable
4. `%USERPROFILE%\.stickyburn\` → installed

`notes.json` and `settings.json` live together there. **Settings → Data** shows the exact resolved path (and warns if a portable location wasn't writable and it fell back). Writability is tested with a real temp-file write, because USB sticks and locked corporate folders lie.

The file format is the contract (see `src/shared/types.ts`):

```jsonc
{
  "version": 2,
  "notes": [{
    "id": "n_8f2k4a", "topic": "WINWATER", "comment": "Send BEP to Powell",
    "due": "2026-08-21T22:00:00.000Z",          // ISO UTC or null
    "created": "…", "updated": "…", "done": false, "doneAt": null,
    "bankedUntil": null, "bankedAt": null,      // snooze; never touches due
    "placement": { "mode": "auto" },            // or { "mode":"manual", "col":0, "row":2, "pinnedAt":"…" }
    "source": "user"                            // "agent" draws a 2px tick on the left edge
  }],
  "messages": [{                                // optional; the talk lane
    "id": "m_4k2p9a", "role": "user",           // "user" | "agent"
    "text": "move winwater to friday",
    "created": "…", "read": false               // read = the OTHER side has seen it
  }]
}
```

`burn`, `warmth` and `state` are never stored — they are derived from `due` and the clock every tick.

## AI access

Two paths, one file, one watcher.

### 1. Just edit the file

Point Claude Code (or any script) at `notes.json`. Writes are picked up within ~300 ms and animate onto the wall; the app's own writes are atomic (`.tmp` → fsync → rename) so a half-written file is never read. Give the agent `src/shared/types.ts` as the schema.

### 2. Built-in MCP server — two transports, same tools

Tools: `list_notes` (with computed burn/state/slot) · `add_note` · `update_note` · `move_note` · `release_note` · `bank_note` · `snuff_note` · `restore_note` · `delete_note` · `parse_line` (dry-run the grammar) · `get_grid` (occupancy map + first free cell) · **`list_messages`** and **`send_message`** (the talk lane).

**The talk lane is pull-based.** When the user types `> …` it is written to the file and shown as waiting, but nothing pushes it to you — an agent sees it when it calls `list_messages`. Poll that at the start of a session, or whenever the user mentions Pyre. The app and the MCP server share `src/shared/heat.ts`, so an agent's `burn` is exactly what's on the screen.

**Settings → AI access** shows both configs with the correct path/port and COPY buttons.

**(a) Local HTTP endpoint — works from any build while the rail is open, no Node needed**

The running app serves streamable-HTTP MCP at `http://127.0.0.1:41777/mcp` (port in Settings; 0 = off; loopback only).

```json
{ "mcpServers": { "pyre": { "url": "http://127.0.0.1:41777/mcp" } } }
```

| Client | How |
|---|---|
| **Cursor** | paste into `.cursor/mcp.json` (project) or `%USERPROFILE%\.cursor\mcp.json` (global) — Cursor Settings → MCP |
| **Claude Code** | `claude mcp add --transport http pyre http://127.0.0.1:41777/mcp` |
| **Claude Desktop** | stdio only today — use (b), or bridge with `npx mcp-remote http://127.0.0.1:41777/mcp` if you have Node |

**(b) stdio — `Pyre.exe --mcp`, works even when the rail is closed**

```json
{ "mcpServers": { "pyre": { "command": "C:\\path\\to\\Pyre.exe", "args": ["--mcp"] } } }
```

| Client | Where |
|---|---|
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` (Settings → Developer → Edit Config) |
| **Cursor** | `.cursor/mcp.json` / `~/.cursor/mcp.json` |
| **Claude Code** | `claude mcp add pyre -- "C:\path\to\Pyre.exe" --mcp` |

> **Which Pyre.exe?** The **installer** build and the **portable folder** build (`Pyre-x.y.z-win.zip`, unzip anywhere) are the real binary and answer stdio MCP. The **single-file portable** `Pyre.exe` is an NSIS launcher that extracts and starts the real app *without* passing stdio through, so `--mcp` cannot work through it — Settings detects this and shows only the HTTP config. Running from source: `command` = `node_modules\electron\dist\electron.exe`, `args` = `["<repo path>", "--mcp"]`.

### 3. Built-in assistant — Pyre answers `>` lines itself

If no external agent is connected, Pyre can drive the same tools directly. **Settings → Assistant** picks a provider; **TEST** does one real round trip and tells you what it found — reachable, model missing, or reachable-but-cannot-call-tools.

| Provider | Key | Default model |
|---|---|---|
| Anthropic | `console.anthropic.com` | `claude-opus-5` |
| Google Gemini | `aistudio.google.com/apikey` | `gemini-2.5-flash` |
| OpenAI | `platform.openai.com` | `gpt-5` |
| OpenRouter | `openrouter.ai/keys` | `anthropic/claude-sonnet-4.5` |
| **Ollama (local)** | **none** | **`phi4-mini`** |
| Custom | optional | any OpenAI-shaped endpoint |

Keys are encrypted at rest with the OS keystore (DPAPI on Windows) in `credentials.bin`, never written to `settings.json` and never handed to the renderer — the window can set, clear and check a key but cannot read one back. `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY` are picked up from the environment if no key is stored.

#### Ollama and phi-4

Nothing leaves the machine and there is no key and no bill:

```
ollama pull phi4-mini
```

Then Settings → Assistant → **Ollama (local)** → TEST. Pyre talks to `http://127.0.0.1:11434/v1`; change the base URL if Ollama runs elsewhere.

> **Use `phi4-mini`, not `phi4`.** The assistant works entirely by calling tools, and Microsoft's 14B `phi4` ships without a tool template — Ollama reports `does not support tools`. The 3.8B `phi4-mini` does support them. Pyre handles the refusal gracefully rather than failing: it retries without tools so the model can still talk about your wall, and says plainly that it cannot change anything with the current model. `llama3.1` and `qwen2.5` also work.

A local model is meaningfully weaker than a frontier one. Expect it to handle "add X due friday" and "what's burning" well, and to need more explicit phrasing for anything multi-step.

## Accessibility

`prefers-reduced-motion` gives a full alternate presentation (no transitions, no embers, no flicker — front position, bloom and the countdown carry the reading). Every note is `Tab`-reachable with all actions on keys; the accessible name reads like *"WINWATER. Send BEP to Powell. Due in 6 minutes. Pinned to column 1, row 3."*

## Layout of the repo

```
src/main       Electron main: window, tray, hotkey, paths, store (atomic + watcher), IPC, --mcp branch
src/preload    contextBridge → window.pyre
src/renderer   plain TS + CSS: grid, drag, composer, sheets, embers  (styles/burn-system.css is verbatim, do not edit)
src/shared     heat.ts (THE burn curve) · grid.ts (THE placement rule) · parse.ts (THE grammar) · types · migrate
src/mcp        stdio MCP server (imports the shared modules + the store)
test           vitest: pyre (spec), parse, store, mcp
reference/     the approved design files, kept for comparison
scripts/       dev helpers (debug driver client, icon)
```

## Dev notes

- `PYRE_DEBUG=1` logs store/watcher activity. `PYRE_DEVTOOLS=1` opens DevTools. `PYRE_DEBUG_DRIVER=<dir>` enables a file-driven debug driver (`scripts/drive.mjs`) that can screenshot and script the live window.
- Running the renderer outside Electron (`npx vite --config vite.config.mts`) installs an in-memory mock bridge with sample notes in every state — handy for visual checks against `reference/note-example.html`.
- Decisions taken on the spec's open items: 9A gone-out (not 9B stalled); 24h ambient warmth kept; a pinned note never auto-releases; no snuff confirmation; single display via settings.
- `reserveScreenSpace` registers the rail as a Windows AppBar (via koffi → `SHAppBarMessage`), so maximised windows stop at its edge. Two things make it fiddly and are worth knowing if you touch it: the reservation must be computed from the **monitor** rect, not the work area (which already excludes your own bar, so it walks across the screen), and it must be in **physical pixels**, not Electron's DIPs. The whole path is wrapped so an FFI failure only means the setting does nothing.
- Talk-lane messages live in the same `notes.json` under an optional `messages` array, so the one watcher delivers both. A file without the key stays valid and only gains it when the lane is first used.
- One correction to the shipped spec: `spec/heat.ts` froze a banked note's burn as of `bankedUntil` (the future) and failed its own test; the record now carries `bankedAt` and the front freezes at the burn it held when banking began.
