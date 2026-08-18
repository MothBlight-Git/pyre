# Handoff: Pyre — burning desktop notes

## Overview
Pyre is a borderless, always-on-top desktop panel of square sticky notes whose urgency is
physical: a note with a deadline burns away from its bottom edge. You glance at the edge of
your monitor and know, without reading a word, what is about to burn you.

Target: an Electron (or Tauri) desktop app on a transparent, frameless window. The rail is
340–420px wide, flush to the work-area right edge, and paints nothing but the notes and a
one-line entry box — there is no panel background, no title bar, no header chrome.

## About the design files
The files in this bundle are **design references authored in HTML/CSS**. They are prototypes
showing intended look and behaviour, not production code to paste in. The task is to
**recreate them in the target codebase's environment** using its established patterns. If no
codebase exists yet, the recommended stack is:

- **Electron** main process for the window, global hotkey and file I/O
- **Renderer**: plain TypeScript + CSS, or React if you prefer — the fire system is pure CSS
  and does not care. No animation library is needed or wanted.

`burn-system.css` in this folder is the exception: it is a **verbatim extraction** of the
approved fire rendering, with the real gradient stops, mask layers and keyframes. Copy it and
build the markup around it rather than reconstructing the gradients by eye — several of the
values are non-obvious and were arrived at by fixing specific visual defects (see Pitfalls).

## Fidelity
**High fidelity.** Colours, type, geometry, gradient stops, easing and durations are final and
should be reproduced exactly. The only intentionally open items are listed under Open decisions.

## The idea in one variable
Urgency is a single continuous driver, not a set of states:

```
t     = hours until due (negative if overdue)
heat  = clamp01(1 - t / 168)          // 7-day horizon
heat  = 1 + min(|t| / 336, 0.35)      // overdue, saturating at 14 days
heat  = 0                             // no due date
--burn = clamp(0, heat * 26%, 26%)    // 30% for the past-overdue phases
```

`--burn` is a registered CSS custom property (`@property`, syntax `<percentage>`,
`inherits: true`). The mask front, every mask bite, the ember line, the white-hot blob row,
the firelight wash, the ember spawn points and the glows all read it via `calc()`. Therefore:

- interpolating between any two states is free — animate one property;
- the JS side never touches geometry: recompute `heat` every 30s and set `--burn`;
- `heat` is **never persisted**. It is derived from `due` and the clock.

The front is deliberately capped at **26%** (30% past overdue). The comment must always remain
readable — a note you cannot read is a note you cannot act on.

## Screens / views

### 1. The rail (primary and only window)
- **Purpose**: glanceable list of everything outstanding, plus one-line capture.
- **Window**: frameless, transparent, always-on-top, skip-taskbar. Width 340px default,
  user-resizable 280–420, persisted. Full work-area height, flush right (left is a setting).
  No panel fill of any kind. 28px invisible drag strip at the top (`-webkit-app-region: drag`).
- **Layout**: 16px gutter. Entry box, then a 2-column grid of square notes, `gap: 20px`
  (the gap exists so bloom and flame tongues never touch a neighbour).
- **Entry box**: full width, 1px `#3A322C` border, radius 3px, padding 10px 12px, Literata 14px,
  placeholder `topic / comment / due` in `#9A9088`. Focus: border to `#E8E2D6` at 60%.
  **No coloured focus ring** — see Colour discipline.
- **Note**: 176px square at 396px window width; 160px at 340px. Radius 3px.
  Subject row (padding 9px 11px, 1px `rgba(25,21,18,.12)` bottom hairline) holding the topic in
  IBM Plex Mono 10.5px/1.0, uppercase, `letter-spacing: .09em`, `#5C544C`. Comment below in
  Literata 13.5px/1.42, `#191512`. Countdown IBM Plex Mono 10.5px, tabular, `#5C544C`,
  bottom-right — **moving into the subject row as soon as the note starts burning**, because the
  burn front would otherwise eat it.
- **Sort**: descending heat, then descending creation time. Undated notes below all dated ones.
  Not user-configurable in v1.
- **Empty state**: centred, Literata italic 13.5px, `#9A9088`: "Nothing on the wall. / Type a
  topic, a slash, and what it's about." No illustration, no button.

### 2. Composer grammar (same window)
`topic / comment [/ due]`. Split on `/`. Two segments = topic + comment. Three = with a due.
More than three: everything up to the last `/` folds into the comment, and the final segment is
treated as a due **only if it parses as a date**; otherwise it stays part of the comment. Leading
`/` is allowed and files under `UNSORTED`. Topic is uppercased for display, stored as typed.

Due parsing, in priority order: `today`/`tonight` (17:00 / 21:00) · `tomorrow`/`tmrw` ·
`fri`/`friday` (next occurrence) · `3d`/`2w`/`4h` (now + offset) · `8/21`, `8-21` (this year, or
next if past) · `2026-08-21` · `8/21 3pm`, `fri 9am`. Default time **17:00 local**.

Live parse preview: three chips below the input (IBM Plex Mono 9.5px, uppercase, `.10em`)
appearing on first keystroke and fading 200ms after commit. An empty role renders as a dashed
outline with its name. The due chip shows the **resolved absolute date**, never the raw string —
so `fri` can never silently mean the wrong Friday. If the third segment fails to parse, the due
chip does not appear and the comment chip visibly absorbs the text. No error message.

`Enter` commits and clears; `Esc` clears without committing. Global hotkey `Ctrl+Alt+N`
focuses the input and raises the window.

## The burn states
| State | `--burn` | Condition | What is added |
|---|---|---|---|
| Cold | 0% | no due date | nothing; warm wash at the bottom edge only |
| Firelight | 0% | > 3 days | warm wash pooled at the bottom, paper still white |
| Glow | 0% | ~2 days | wash turns orange, small halo spills below the note |
| Due (flash) | 8% | inside due window | front just breaks; **warmFlash 6s** + stock warms + backglow pulse; 1 ember |
| Burning | 17% | < 24h | **warmFlashHot 3.4s** double beat, brighter bloom, 2 embers |
| Overdue | 26% | past due | **warmFlashHot 2.6s**, widest bloom, 2 flame tongues in the ±11px overhang, 3 embers |
| Gone out (9A) | 30% | heat > 1.20 (~7d past) | all chroma removed, no flash, stock to `#E4E0D8`, grey veil, one smoke wisp, 0.6px shake every 9s |
| Stalled (9B) | 30% | alternative to 9A | still alight but frozen: 3 dull embers, grey veil, same shake |
| Banked (9C) | frozen | user snoozed | flash and backglow to 1/6, blob row to 3 low embers breathing on 5.5s, wash to .16, wisp every 12s, `BANKED` chip in the subject row |

9A and 9B are **alternatives** — pick one. 9A is the stronger read (in a rail of burning notes
the only quiet one draws the eye); 9B keeps the note legibly "still alive".

Banking never changes the due date. The countdown keeps running beside the topic while the
`BANKED` chip sits at the right of the subject row, so the damping cannot hide a real deadline.
`B` banks 2h, `shift-B` the rest of the day; a third bank on the same note offers the edit sheet
instead. Sort position does not change.

## Layer order (load-bearing)
Inside each note wrapper, in DOM order:

1. `.note__backglow` — even all-round radial, inset −16…−26px, blur 10px, pulses with the flash
2. `.note__halo` — bottom-anchored radial for the fire itself, blur 9px
3. `.note__ember-line` — blob row + ramp, `inset: 0`, **under the card**
4. `.note__tongues` — overdue only
5. `.note__card` — the masked paper, containing subject row / comment / countdown
6. `.ember` particles
7. `.note__wash` — the firelight warmth, `z-index: 99`, **exactly one per note, unmasked**

Every fire layer must be a sibling of the card at `inset: 0` so it shares the card's 176px
coordinate space. Sizing a fire layer against its own smaller box puts the glow in the wrong
place — that was a real bug.

## Interactions & behaviour
- **Note enters**: from `translateY(-10px) rotate(-1.8deg) scale(.97)`, opacity 0 → settle,
  320ms `cubic-bezier(.22,1,.36,1)`. Enters at its true `--burn`; no burn-in animation.
- **Reorder**: FLIP transform, 260ms `cubic-bezier(.4,0,.2,1)`. Notes slide; never fade-swap.
- **Tier crossing**: 600ms front sweep on `cubic-bezier(.4,0,.2,1)` plus a one-shot bloom flare
  to 1.15× settling over 400ms. Fires only while the app is open.
- **Continuous tick**: recompute heat every 30s and set `--burn`; a 2.4s ease-out transition on
  the property absorbs the step so nothing visibly jumps.
- **Snuff (mark done)**: `--burn` → 0% over 220ms while the note desaturates, two grey smoke
  particles drift up over 500ms, then the note slides right out over 280ms. ~1s total. This is
  the reward moment — spend the frames.
- **Delete**: scale to .94 and fade over 180ms. No smoke. Deleting is not an achievement.
- **Hover**: `translateY(-1px)`, shadow deepens, 120ms. Actions replace the countdown position:
  ✓ snuff, ✎ edit (the note becomes a mini-composer prefilled with `topic / comment / due`),
  ✕ delete. 14px, `#5C544C`.
- **Keys**: notes are `Tab`-reachable. `Enter` edits, `Cmd/Ctrl+Enter` snuffs, `Delete` deletes,
  `B` banks.
- **Reduced motion**: `prefers-reduced-motion: reduce` kills every animation and the `--burn`
  transition. Front position, blob row, bloom, size and countdown still carry the urgency.

## State management
```ts
type Note = {
  id: string;            // "n_" + 6 base36
  topic: string;         // as typed; display uppercases
  comment: string;       // required, non-empty
  due: string | null;    // ISO 8601 UTC; null = cold
  created: string; updated: string;
  done: boolean; doneAt: string | null;
  bankedUntil?: string | null;   // 9C; does not alter `due`
  stock: 'bone' | 'manila' | 'slate';   // assigned round-robin, immutable
  source: 'user' | 'agent' | string;
};
```
File: `~/.stickyburn/notes.json` (override `PYRE_DATA`), `{ version: 1, notes: [...] }`.
Writes are atomic: write `.tmp`, `fsync`, `rename`. Watch the file with `fs.watch`, debounced
150ms, self-write suppression via mtime + a write token — anything that edits the file
live-updates the rail. Agent-created notes carry `source: "agent"` and render with a 2px
`#3A322C` tick on their left edge (no colour spent).

Renderer state is only: the note list, the composer buffer + parse result, hover/focus, and a
30s tick. Everything visual derives from `due` + now.

**AI access** (optional, from the original spec): an MCP stdio server `pyre-mcp` exposing
`list_notes`, `add_note`, `update_note`, `snuff_note`, `delete_note`, `parse_line`, writing to the
same file so the watcher animates agent notes in exactly like human ones. `list_notes` returns
computed `heat` and `humanDue`.

**Write failure**: a single hairline strip under the entry box in `#6B3A16` — "Can't write to
notes.json. Your last note is held in memory. Check file permissions." Retry every 10s.

## Design tokens
**Paper + ink (achromatic)**
| Token | Value | Use |
|---|---|---|
| paper stock | `#FBFAF6` | live note |
| paper cool | `#E4E0D8` | gone-out (9A) |
| paper stalled | `#EFE9DF` | stalled (9B) |
| paper banked | `#F4F1EA` | banked (9C) |
| ink-900 | `#191512` | body copy on paper |
| ink-500 | `#5C544C` | **the only** meta ink on paper |
| ink-on-soot | `#9A9088` | meta text on the desktop |
| hairline | `rgba(25,21,18,.12)` | subject-row rule |
| soot hairline | `#3A322C` | entry box border, provenance tick |

**Ignition ramp** — the only saturated values in the product
| Token | Value | Use |
|---|---|---|
| trough | `rgba(206,72,20,.85)` | just under the front (gives the fire depth) |
| mid | `#FFB347` | ramp toward the front |
| core | `#FFFBEE` | the front itself |
| high | `#FFD27A` | just above the front |
| blob core | `#FFFDF6` | white-hot blobs on the burn line |
| bloom | `rgba(255,170,80,.6)` | drop-shadow / halo tint |
| tongue | `#FFF3CE` → `#FFA83C` | overdue flame tongues |

**Type**: IBM Plex Mono 500 (topic 10.5px/1.0 `.09em` uppercase; countdown 10.5px tabular;
rail meta 10px 600 `.14em`) and Literata 400 (comment 13.5px/1.42, composer 14px/1.4, empty
state italic). Literata is a screen-reading serif — never set it large or thin. Fallbacks:
Source Serif 4, then Georgia.

**Spacing**: 4 / 8 / 12 / 16 / 20 / 24 / 32. **Radius**: 3px (paper is cut, not rounded).
**Shadow**: cold `0 2px 0 rgba(0,0,0,.45–.5)`; burning notes drop it entirely for a warm bloom.

## Colour discipline (the rule that makes this design work)
The entire UI is achromatic paper and light. **Fire is the only chroma in the product.** No brand
colour, no accent hue on buttons, links, focus rings or the logo. Focus is a 2px bone outline at
2px offset. If a pixel is saturated, it is on fire. Meta text on paper is `#5C544C` and nothing
else; meta text on the desktop is `#9A9088` and nothing else. Three separate review rounds on
this design were spent removing invented ink colours — do not add any.

## Pitfalls (each of these was a real bug in the prototype)
1. **Two wash copies.** Putting the firelight wash inside the masked card *and* on top makes the
   inner copy fade with the mask, producing a bright band across the feather. Exactly one wash,
   unmasked, at `z-index: 99`.
2. **Adjacent gradient stops.** Two wash stops ~1% apart with a 0.1 alpha step read as a hard
   bright line. Keep adjacent stops ≥ 3% apart and monotone.
3. **Dark stops below the front.** Any brown (`#6B3A16`, `#C6740F`) painted below the burn front
   sits on the desktop and reads as a dirty line. The ramp has no dark stop except the trough,
   which is above the front.
4. **Hard black shadow on a burning note.** `0 2px 0 rgba(0,0,0,.5)` paints a dark strip under
   the fire. Burning states use a warm bloom only.
5. **Fire layers in the wrong box.** A glow layer sized against its own box instead of the card's
   176px box lands tens of pixels off the front.
6. **`mix-blend-mode: screen` on a transparent window.** Inverts against nothing. Use normal
   blend with bright colours.
7. **Straight burn line.** With too few mask bites, columns with no bite overhead show the plain
   linear front. Ten overlapping bites, centres every ~11%, keeps it jagged all the way across.
8. **Text safe zone.** The front must never rise into the comment: cap `--burn`, keep the ember
   line under the card, and move the countdown into the subject row once burning.

## Accessibility floor
`#191512` on every paper stock is ≥ 12:1; `#5C544C` is ≥ 6.5:1. Reduced motion is a full
alternate presentation, not a degradation. Every note is keyboard reachable and every action has
a binding. Fire state is announced, not only shown: a note's accessible name is
"{topic}. {comment}. Due in 6 hours." / "Overdue by 2 days." Colour is never the sole carrier —
urgency is also front position, size of glow, and the countdown string.

## Settings
Dock side (right/left) · panel width 280–420 · always on top · reserve screen space ·
default due time (17:00) · global hotkey · data file path (display + reveal) · Done archive ·
start with system.

Done archive: snuffed notes stay in `notes.json` with `done: true`, excluded from the rail and
the header count. The archive view shows the last 50, reverse chronological, as flat grey chips
with no fire system. Restoring returns the note with its original due date.

## Open decisions
1. **9A vs 9B** for the past-overdue phase.
2. Cold notes inline at the bottom, or collapsed behind a `12 undated ▾` divider once there are
   20+ of them.
3. Whether snuff needs confirmation. Currently no — it is reversible from the archive, but the
   animation is a full second, which is a long time to watch a mistake.
4. Multi-monitor: spec assumes the primary display; pinning to a chosen display is a settings line.
5. Whether 7 days is the right horizon for heat = 0.

## Files in this bundle
| File | What it is |
|---|---|
| `burn-system.css` | verbatim extraction of the fire system: `@property --burn`, tokens, 11-layer mask, blob row, wash, glows, tongues, all keyframes, per-state bindings. **Start here.** |
| `note-example.html` | minimal standalone page: one note in each state, wired to `burn-system.css`. Open it in Chrome to confirm your build matches. |
| `Pyre Rail Directions.dc.html` | the full design document: every exploration, the six sampled burn stages, two live `--burn` demos, the past-overdue phases, and the written spec panels. Reference, not source. |

## Suggested build order
1. Electron shell: frameless + transparent + always-on-top window, invisible drag strip,
   `~/.stickyburn/notes.json` atomic read/write + watcher.
2. Static rail: entry box + 2-column grid of cold notes, correct type and geometry.
3. `burn-system.css` in, `--burn` wired to a hardcoded value per note — verify against
   `note-example.html`.
4. Heat function + 30s tick + `--burn` transition; then sort order.
5. Composer grammar, date parser and the three live parse chips.
6. Flash/backglow states, tier-crossing flare, snuff and enter/reorder motion.
7. Banking, past-overdue phase, Done archive, settings.
8. Optional: `pyre-mcp`.
