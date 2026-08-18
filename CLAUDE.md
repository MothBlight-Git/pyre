# PYRE — build spec

A frameless, transparent, always-on-top desktop grid of square paper notes. A note with a deadline **burns away from its bottom edge in the last two hours**. Notes can be dragged anywhere on the grid; burning ones claim the top-left unless you have moved them yourself. Everything is readable and writable by an AI agent. The whole thing runs from a single portable executable.

This document is the build contract. Read it fully before writing code.

---

## 0. Authority order

When these disagree, higher wins:

1. **This file** — the current requirements.
2. **`reference/burn-system.css`** — an approved verbatim extraction of the fire rendering. Copy it in unchanged. Several gradient stops are non-obvious and were arrived at by fixing specific visual defects; reconstructing them by eye will look wrong and you will not know why.
3. **`reference/note-example.html`** — the fidelity target. Open it in Chrome; your build must match it.
4. **`reference/design-handoff.md`** — the design system doc. Still authoritative for type, colour, layer order, motion and copy. Superseded only where §1 below says so.
5. **`reference/Pyre Rail Directions.dc.html`** — the full design exploration. Reference, not source.

`spec/` holds tested reference implementations of the two things the design files do not cover. Copy them into `src/` as indicated in each header; they are not pseudocode.

---

## 1. What changed since the design handoff

Four requirements landed after the design was approved. Each one supersedes part of it.

| # | Change | Supersedes |
|---|---|---|
| 1 | **Burning starts at T−2h and maxes at due.** | The 7-day heat horizon and `heat = clamp01(1 − t/168)`. The "firelight · 5d" and "glow · 2d" stages are no longer burn stages — they become the ambient warmth band (§2.2). |
| 2 | **Notes are draggable on a free grid.** | "Sort: descending heat… not user-configurable in v1." |
| 3 | **Burning notes take the top-left unless intentionally moved.** | The pure sort. Sort now governs only unpinned notes. |
| 4 | **Portable single-file package.** | `~/.stickyburn/notes.json` as the only data location. |

Two schema consequences, both breaking:

- **`placement` is added** to the note record. It is the entire override rule.
- **`stock` is removed.** The design converged on one live paper (`#FBFAF6`) with the other stocks as *state* skins (gone-out, stalled, banked). A per-note random stock now fights that system. Migration drops the field.

File `version` goes `1 → 2`. Migration in §5.3.

---

## 2. The burn curve

Reference implementation: **`spec/heat.ts`** → copy to `src/shared/heat.ts`. Tested in `spec/pyre.test.ts`.

### 2.1 The fuse

```
t = minutes until due (negative once overdue)

t > 120        burn = 0
0 < t ≤ 120    burn = 26 · ((120 − t) / 120) ^ 1.6
t ≤ 0          burn = 26 + 4 · min(−t / 1440, 1)      → 30 at 24h overdue, then flat
no due         burn = 0
```

The `^1.6` ease-in pushes the visible drama into the final half hour, which is where it earns attention. Verify against these — the curve was chosen because it passes through all three approved sample renders:

| t | burn | design sample |
|---|---|---|
| 120m | 0.00% | fuse not lit |
| 60m | 8.58% | "due" = 8% |
| 30m | 16.41% | "burning" = 17% |
| 10m | 22.62% | — |
| 0 | 26.00% | "overdue" = 26% |
| −24h+ | 30.00% | capped |

The cap is not stylistic. **The comment must stay readable — a note you cannot read is a note you cannot act on.** Never let `--burn` exceed 30%.

### 2.2 Ambient warmth — the second driver

A strict 2-hour fuse means a note due in three hours looks identical to one due in three weeks. To keep the anticipation the design had, a **separate** variable ramps the firelight wash over the last 24 hours without consuming any paper:

```
warmth = 0.18                                   t > 1440 or no due
warmth = 0.18 + 0.82 · (1 − t/1440)             0 < t ≤ 1440
warmth = 1                                      t ≤ 0
```

`--warmth` drives *only* the wash and halo opacity, and *only* in the `cold` and `warming` states (`spec/grid-system.css` §3). Once the fuse lights, the wash is owned by the `warmFlash` keyframes and warmth must not fight them.

This is the one place the spec adds a driver the design deliberately did not have. **To go strictly binary — nothing at all until T−2h — return `0.18` unconditionally from `warmthFor()`.** One line, no other changes. See §11.1.

### 2.3 States

| State | Condition | `--burn` |
|---|---|---|
| `cold` | no due date | 0% |
| `warming` | due set, t > 120m | 0% |
| `due` | burn < 12% | 0–12% |
| `burning` | 12% ≤ burn < 22% | 12–22% |
| `critical` | burn ≥ 22%, t > 0 | 22–26% |
| `overdue` | t ≤ 0 | 26–30% |
| `gone-out` | t ≤ −7d | 30% |
| `banked` | `bankedUntil` in the future | frozen |

`critical` and `warming` are new; `spec/grid-system.css` §8 adds their bindings. `critical` gets overdue's heartbeat but **no tongues** — the paper is not gone yet, so nothing should be licking past its edges.

### 2.4 Driving it

Every tick, for each note: compute `evaluate(note)`, then set on the note element

```ts
el.style.setProperty('--burn', `${burn}%`);
el.style.setProperty('--warmth', String(warmth));
el.dataset.state = state;
```

`burn-system.css` also binds a literal `--burn` per state (`[data-state="burning"] { --burn: 17% }`). **An inline custom property beats an attribute-selector rule**, so the continuous value always wins. Keep those static bindings as a stall fallback. Never add `!important`.

**Tick cadence is variable** — a flat 30s tick visibly steps the front in the last minutes of a 2-hour fuse. `nextTickMs()`: 60s when cold, 30s inside the fuse, 10s under 20 minutes, 5s under 5 minutes. Schedule with `setTimeout` off the soonest note, not a fixed `setInterval`.

The CSS `transition: --burn 2.4s ease-out` absorbs each step. On a tier crossing, set `data-crossing` for 600ms to swap in the faster sweep, then remove it.

---

## 3. The grid

Reference implementation: **`spec/grid.ts`** → copy to `src/shared/grid.ts`.

### 3.1 Geometry

Notes are squares in a 1–2 column grid. **Note size is derived from rail width, not fixed.**

The design files quote "176px at a 396px rail" and "160px at 340px". Neither fits two columns at 16px gutters and a 20px gap — 176px needs 404px, 160px needs 372px. Rather than pick a magic width, `gridMetrics()` solves for the largest square that fits:

| Rail | Result |
|---|---|
| 280px | 1 col @ 200px (row centred) |
| 340px | 2 col @ 144px |
| 396px | 2 col @ 172px |
| 420px | 2 col @ 184px |

The burn system is entirely percentage-based and rescales for free. Only the fixed-px type degrades, which is where the 140px floor comes from. **Never shrink the 20px gap** — it exists so bloom and tongues never touch a neighbour.

Notes are absolutely positioned via `transform: translate3d(col·pitch, row·pitch, 0)`, not CSS grid. We already compute exact cells, and absolute coords make FLIP and drag trivial.

### 3.2 Placement — the override rule

```ts
type Placement =
  | { mode: 'auto' }
  | { mode: 'manual'; col: number; row: number; pinnedAt: string };
```

`layout()` resolves every note to a cell in a fixed order:

1. **Manual notes claim first.** Sorted by `pinnedAt` ascending — the older pin wins a contested cell. Columns are clamped into range (the rail is resizable, so a pin can fall outside it). Any note whose stored slot had to change comes back in `corrections` and **must be persisted**, or it will drift again on the next resize.
2. **Auto notes fill what is left**, in reading order from (0,0), sorted by descending burn → dated above undated → newest first.

The consequence, which is the whole feature: **an auto note that is fully on fire will never evict a manually placed cold note.** The user's hand beats the sort. It flows around.

### 3.3 Drag

Pointer Events only. HTML5 drag-and-drop has no usable drag image on a transparent Electron window and cannot be cancelled cleanly mid-gesture.

| Phase | Behaviour |
|---|---|
| `pointerdown` | Capture. Record offset. Do not lift yet. |
| 4px threshold | Lift: `data-dragging`, card scales 1.04 and rotates 1.5°, `z-index: 400`. Burning notes keep their bloom — a hard shadow paints a dark strip under the fire. |
| move | Note follows the pointer directly (transition off). `slotAtPoint()` resolves the target, which **snaps to the nearest cell centre**, so a pointer resting in the 20px gap always resolves to one side. Dashed bone `.drop-target` animates to that cell. Other notes reflow live behind it. |
| edge | Within 40px of the top or bottom, auto-scroll at 6px/frame. |
| `pointerup` | Commit: `placement = { mode:'manual', col, row, pinnedAt: now }`. `data-settling` for 200ms while the note eases into its cell. |
| `Esc` mid-drag | Cancel. Snap back, placement unchanged. |

Dragging is the *only* thing that sets `manual`. That is what "intentionally moved away" means — nothing else should ever pin a note.

**Release back to auto:** hover action `⇱` (only visible on manual notes), or `R`. Sets `placement = { mode:'auto' }`.

### 3.4 The flare pip

A pinned note can be dragged to row 9 and then catch fire below the fold. We never move it — but we never let a fire hide either.

`hiddenFires()` returns burning notes whose row is below the visible fold. If non-empty, show `.flare-pip` bottom-right: an ember dot breathing on 2.6s plus a count. Click scrolls the hottest one into view. It does not move anything.

---

## 4. Stack and layout

Electron. Main process for window, hotkey and file I/O; renderer in plain TypeScript. **No framework and no animation library** — the fire is pure CSS and a virtual DOM actively gets in the way of FLIP.

```
pyre/
├── CLAUDE.md
├── package.json
├── electron-builder.yml
├── tsconfig.json
├── src/
│   ├── main/
│   │   ├── index.ts        app lifecycle, global hotkey, tray, --mcp branch
│   │   ├── window.ts       frameless/transparent/always-on-top, dock, resize
│   │   ├── paths.ts        portable vs installed data resolution (§6.2)
│   │   ├── store.ts        atomic read/write, fs.watch, self-write suppression
│   │   └── ipc.ts          PyreApi handlers
│   ├── preload/index.ts    contextBridge → window.pyre
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.ts         bootstrap, variable tick, change subscription
│   │   ├── note.ts         element factory, state binding
│   │   ├── grid-view.ts    applies layout(), FLIP, flare pip
│   │   ├── drag.ts         pointer drag (§3.3)
│   │   ├── composer.ts     input, parse chips, commit
│   │   └── styles/
│   │       ├── burn-system.css    ← verbatim, DO NOT EDIT
│   │       ├── grid-system.css    ← from spec/, additive
│   │       └── shell.css          rail, composer, empty state, archive
│   ├── shared/
│   │   ├── types.ts        ← from spec/
│   │   ├── heat.ts         ← from spec/  SINGLE SOURCE OF TRUTH
│   │   ├── grid.ts         ← from spec/
│   │   ├── parse.ts        composer grammar + date parser (§7)
│   │   └── migrate.ts      v1 → v2
│   └── mcp/server.ts       stdio MCP, imports shared/heat + main/store
├── reference/              the design files, kept for comparison
└── test/pyre.test.ts       ← from spec/
```

**`shared/heat.ts` is imported by both the renderer and the MCP server.** If `list_notes` ever reports a different burn than the screen shows, an agent and the user are looking at two different products. Do not fork it.

---

## 5. Data

### 5.1 File

```jsonc
{
  "version": 2,
  "notes": [
    {
      "id": "n_8f2k4a",
      "topic": "WINWATER",
      "comment": "Send BEP to Powell",
      "due": "2026-08-21T22:00:00.000Z",
      "created": "2026-08-17T14:02:11.318Z",
      "updated": "2026-08-17T14:02:11.318Z",
      "done": false,
      "doneAt": null,
      "bankedUntil": null,
      "placement": { "mode": "manual", "col": 0, "row": 2, "pinnedAt": "2026-08-17T15:10:00.000Z" },
      "source": "user"
    }
  ]
}
```

Full types in `spec/types.ts`. `burn`, `warmth` and `state` are **never persisted** — they are derived from `due` and the clock every tick. Persisting them guarantees drift.

### 5.2 Durability

Writes are atomic: write `notes.json.tmp`, `fsync`, `rename`. Watch with `fs.watch` debounced 150ms, with self-write suppression via mtime plus a write token. Anything that edits the file — an agent, a text editor, a script — live-updates the grid. **This is the mechanism that makes AI access work with no extra surface**, so get it right early; §8 depends on it entirely.

On write failure: hairline strip under the composer in `#6B3A16`, copy from design-handoff. Hold the note in memory, retry every 10s.

### 5.3 Migration v1 → v2

On load, if `version === 1`: set `placement = { mode: 'auto' }` on every note, delete `stock`, set `version = 2`, write once. Back up the original to `notes.v1.bak.json` first. Idempotent.

---

## 6. Portable package

### 6.1 Build

`electron-builder`, Windows target `portable` → a single `Pyre.exe` that runs with no install and no admin rights. Also emit `nsis` for people who want a Start Menu entry.

```yaml
# electron-builder.yml
appId: com.pyre.notes
win:
  target: [portable, nsis]
portable:
  artifactName: Pyre.exe
  unpackDirName: false        # extract to temp, not a fixed path
```

### 6.2 Data resolution

`src/main/paths.ts`, in order — first hit wins:

1. `PYRE_DATA` env var.
2. A `pyre.portable` marker file beside the executable → `./pyre-data/notes.json`.
3. `./pyre-data/` beside the executable already exists and is writable → portable mode.
4. `~/.stickyburn/notes.json` → installed mode.

Portable mode must probe writability with a real temp-file write, not a permissions check — USB sticks and locked corporate directories lie. If the probe fails, fall through to 4 and surface the fallback in settings so the user is never silently writing somewhere they did not expect.

Settings live beside notes (`settings.json`) in the same resolved directory, so the whole state travels together.

### 6.3 The MCP server ships inside the same binary

Do not publish a separate npm package — that would require Node on the target machine and break portability.

```
Pyre.exe --mcp
```

launches the stdio MCP server using Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`, set in `main/index.ts` before any window is created; branch on `process.argv` first thing and never create a `BrowserWindow` in that path). One binary, both modes, zero dependencies on the host.

Claude Desktop config for the user:

```json
{ "mcpServers": { "pyre": { "command": "C:\\path\\to\\Pyre.exe", "args": ["--mcp"] } } }
```

---

## 7. Composer

Unchanged from design-handoff — implement it as written there. Summary for completeness:

`topic / comment [/ due]`. Split on `/`; two segments = no due; three = with a due. More than three: everything up to the last `/` folds into the comment, and the final segment is a due **only if it parses as a date**, otherwise it stays in the comment. Leading `/` files under `UNSORTED`.

Due parsing, in priority order: `today`/`tonight` (17:00/21:00) · `tomorrow`/`tmrw` · `fri`/`friday` · `3d`/`2w`/`4h` · `8/21`, `8-21` · `2026-08-21` · `8/21 3pm`, `fri 9am`. Default time 17:00 local.

Three live parse chips below the input. The due chip shows the **resolved absolute date, never the raw string** — so `fri` can never silently mean the wrong Friday. If the third segment fails to parse, the due chip does not appear and the comment chip visibly absorbs the text. No error message.

`Enter` commits, `Esc` clears. Global hotkey `Ctrl+Alt+N` focuses and raises.

One addition for the 2h fuse: if a committed note is **already inside the fuse** (due in under 2 hours), it enters at its true `--burn` with no ignition animation, consistent with "new note enters at its true `--burn`".

---

## 8. AI access

Two paths, one file, one watcher. Both go through `store.ts` so atomicity and the watcher are shared.

### 8.1 Direct file access

`spec/types.ts` is the contract. Point Claude Code at the resolved `notes.json` and it can read and write directly; the grid animates the change in within ~300ms. Document the resolved path in the README so it is findable without guessing.

### 8.2 MCP tools

| Tool | Input | Notes |
|---|---|---|
| `list_notes` | `{ includeDone?, topic?, dueBefore?, burningOnly? }` | Returns each note plus computed `burn`, `warmth`, `state`, `minutesToDue`, `label`, and resolved `slot`. |
| `add_note` | `{ topic, comment, due?, col?, row? }` | Supplying `col`/`row` pins it; omitting them leaves it `auto`. `source: "agent"`. |
| `update_note` | `{ id, topic?, comment?, due? }` | |
| `move_note` | `{ id, col, row }` | Sets manual placement, exactly as a drag would. |
| `release_note` | `{ id }` | Back to auto. |
| `bank_note` | `{ id, until }` | Damps the fire. **Never alters `due`.** |
| `snuff_note` | `{ id }` | Mark done. |
| `delete_note` | `{ id }` | |
| `parse_line` | `{ line }` | Dry-runs the §7 grammar so an agent can preview before committing. |
| `get_grid` | `{}` | Occupancy map + `{ cols, noteSize, rows }` so an agent can reason about free cells before placing. |

Agent-created notes render a 2px `#3A322C` tick on their left edge. Manual placement renders a 2px `rgba(92,84,76,.5)` tick on the right. Both are structural greys — **no chroma is spent**, per §10.

---

## 9. Build order

Each step ends in something checkable. Do not proceed past a red checkpoint.

1. **Shell.** Frameless + transparent + always-on-top window, 28px invisible drag strip, dock right/left, resize 280–420 persisted. → *Window floats over the desktop with no background and no title bar; dragging the top strip moves it.*
2. **Store.** `paths.ts` resolution, atomic write, `fs.watch` with self-write suppression, v1→v2 migration. → *Edit `notes.json` in a text editor; the main process logs the change within 300ms and does not loop.*
3. **Static grid.** Composer + cold notes at correct geometry from `gridMetrics()`. → *Matches `note-example.html` cold state; resizing the rail reflows columns and note size.*
4. **Fire.** `burn-system.css` in verbatim, `--burn` hardcoded per note. → *Side-by-side with `note-example.html` at 8% / 17% / 26%, visually identical.*
5. **Curve.** `heat.ts`, variable tick, `--burn` + `--warmth` + `data-state` wiring, `data-crossing` sweep. → *`test/pyre.test.ts` green. A note due in 90 minutes visibly breaks its front and climbs.*
6. **Placement.** `grid.ts`, `layout()` on every change, FLIP reorder, `corrections` persisted. → *Grid tests green. A note entering the fuse animates to (0,0).*
7. **Drag.** Pointer drag, drop target, edge scroll, release-to-auto, flare pip. → *Drag a cold note to (0,0); a burning note flows to (1,0) instead of evicting it, and survives restart.*
8. **Composer.** Grammar, date parser, three live parse chips.
9. **States.** Snuff, delete, hover actions, banking, gone-out phase, Done archive, empty state.
10. **Portable + MCP.** `--mcp` branch, tool handlers, electron-builder portable target. → *`Pyre.exe --mcp` answers `initialize` on stdio; `add_note` appears on the grid without a restart.*

---

## 10. Non-negotiables

Inherited from the design and still binding.

**Colour discipline.** The entire UI is achromatic paper and light. **Fire is the only chroma in the product.** No accent hue on buttons, focus rings, drop targets or the flare pip label. Focus is a 2px bone outline at 2px offset. Meta ink on paper is `#5C544C` and nothing else; on the desktop `#9A9088` and nothing else. Three review rounds were spent removing invented ink colours — do not add any.

**Layer order inside a note** (DOM order, all siblings of the card at `inset: 0`): backglow → halo → ember line → tongues → **card** → embers → wash (`z-index: 99`). Sizing a fire layer against its own box instead of the card's box puts the glow tens of pixels off the front. This was a real bug.

**Pitfalls from the prototype**, each of which was a real defect:

1. Exactly **one** firelight wash per note, unmasked, on top. A second copy inside the masked card fades with the mask and leaves a bright band across the feather.
2. Keep adjacent wash gradient stops ≥3% apart and monotone. A 0.1 alpha step over 2px reads as a hard line.
3. No dark stop below the burn front. Brown painted below the front sits on the desktop and reads as a dirty line.
4. Burning notes drop the hard black shadow entirely — it paints a dark strip under the fire. Warm bloom only. **This applies to the drag lift too.**
5. No `mix-blend-mode: screen` — it inverts against a transparent window. Normal blend with bright colours.
6. Ten overlapping mask bites minimum, centres every ~11%, or columns with no bite overhead show the plain straight front.
7. Text safe zone: cap `--burn` at 30%, keep the ember line under the card, and move the countdown into the subject row as soon as the note starts burning.

**Accessibility.** `prefers-reduced-motion` is a full alternate presentation, not a degradation: `--burn` is set but never transitioned, position changes are instant, embers and flicker are off. Front position, bloom and countdown still carry the whole reading. Every note is `Tab`-reachable; `Enter` edits, `Ctrl+Enter` snuffs, `Delete` deletes, `B` banks, `R` releases. Accessible name is `"{topic}. {comment}. Due in 6 minutes."` / `"Overdue by 2 days. Pinned to column 1, row 3."` — a screen reader must get both the urgency and the placement without the fire.

---

## 11. Open decisions

Flagged rather than decided silently. Each is a small, isolated change.

1. **Ambient warmth (§2.2).** Kept, ramping over 24h, because a strict 2h fuse makes everything else uniform. If you want the fuse to be the only signal, return `0.18` unconditionally from `warmthFor()`. This is the one place I added something you did not ask for — it is one line to remove.
2. **Does a burning note ever reclaim (0,0)?** Currently never: a pin is permanent until released, and the flare pip handles the buried case. The alternative is an auto-release when a pinned note goes overdue. That would be easier to live with and harder to trust — it means the app moves your things.
3. **`gone-out` (9A) vs `stalled` (9B).** Still open from the design handoff. 9A is the stronger read. `burn-system.css` implements both; pick one and delete the other's bindings.
4. **Row limit.** The grid scrolls without bound. Past ~40 notes the top-left rule stops helping because most of the grid is off-screen. A cap, or collapsing undated notes behind a `12 undated ▾` divider, is worth considering once you see it full.
5. **Multi-monitor.** Spec assumes one display, chosen in settings. Following the cursor across displays is a different product.
6. **Does snuff need confirmation?** Currently no — it is reversible from the Done archive, but the snuff animation is a full second, which is a long time to watch a mistake.

---

## 12. Bootstrapping this repo

```bash
mkdir pyre && cd pyre
# copy CLAUDE.md, reference/ and spec/ from this package in
npm init -y
npm i -D electron electron-builder typescript vite vitest @types/node
npm i @modelcontextprotocol/sdk

mkdir -p src/{main,preload,renderer/styles,shared,mcp} test
cp spec/heat.ts spec/grid.ts spec/types.ts src/shared/
cp spec/pyre.test.ts test/
cp reference/burn-system.css spec/grid-system.css src/renderer/styles/

npx vitest run          # heat + grid tests should pass before you build anything
```

Then work §9 in order. Open `reference/note-example.html` in Chrome and keep it beside the app from step 4 onward — it is the only reliable way to catch fire-rendering drift.
