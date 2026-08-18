/**
 * Composer: `topic / comment [/ due]` with three live parse chips (CLAUDE.md §7).
 * The due chip shows the RESOLVED absolute date, never the raw string. If the
 * third segment fails to parse the due chip does not appear and the comment
 * chip visibly absorbs the text. No error message.
 * Enter commits, Esc clears. Chips appear on first keystroke and fade 200ms
 * after commit.
 */
import { parseLine, parseCommand, parseMessage, formatDue, displayTopic, type ParsedLine, type Command } from '../shared/parse';

export interface ComposerDeps {
  input: HTMLInputElement;
  chips: HTMLElement;
  cmdChip: HTMLElement;
  defaultTime: () => string;
  onCommit: (p: ParsedLine) => Promise<void>;
  onCommand: (c: Command) => Promise<void> | void;
  onMessage: (text: string) => Promise<void>;
}

export function installComposer(d: ComposerDeps): { focus: () => void; refresh: () => void } {
  const chip = (role: string) => d.chips.querySelector<HTMLElement>(`.chip[data-role="${role}"]`)!;
  const topicChip = chip('topic'), commentChip = chip('comment'), dueChip = chip('due');
  let fadeTimer: number | null = null;

  const setChip = (el: HTMLElement, text: string, empty: boolean, name: string) => {
    if (empty) { el.dataset.empty = ''; el.textContent = name; }
    else { delete el.dataset.empty; el.textContent = text; }
  };

  const render = () => {
    const raw = d.input.value;
    if (!raw.trim()) { d.chips.hidden = true; d.cmdChip.hidden = true; return; }
    if (fadeTimer) { window.clearTimeout(fadeTimer); fadeTimer = null; }
    delete d.chips.dataset.fading;

    // "> …" is a message to the connected agent, not a note.
    const msg = parseMessage(raw);
    if (msg !== null || raw.trimStart().startsWith('>')) {
      d.chips.hidden = true;
      d.cmdChip.hidden = false;
      d.cmdChip.textContent = msg ? 'SAY TO AGENT' : 'SAY TO AGENT …';
      return;
    }

    // A bar command owns the line: show one chip saying what Enter will do.
    const cmd = parseCommand(raw);
    if (cmd) {
      d.chips.hidden = true;
      d.cmdChip.hidden = false;
      d.cmdChip.textContent = cmd.label;
      return;
    }
    d.cmdChip.hidden = true;
    d.chips.hidden = false;
    const p = parseLine(raw, { defaultTime: d.defaultTime() });
    setChip(topicChip, displayTopic(p.topic), false, 'topic');
    if (p.segments < 2) setChip(topicChip, p.topic ? displayTopic(p.topic) : 'topic', !p.topic, 'topic');
    setChip(commentChip, p.comment, !p.comment.trim(), 'comment');
    if (p.due) {
      setChip(dueChip, formatDue(p.due), false, 'due');
      delete dueChip.dataset.show;
    } else {
      setChip(dueChip, '', true, 'due');
      // Show the dashed "due" placeholder only while the user is on the 3rd segment and it's still empty.
      if (p.segments >= 3 && !raw.split('/').pop()!.trim()) dueChip.dataset.show = '';
      else delete dueChip.dataset.show;
    }
  };

  const clear = () => {
    d.input.value = '';
    d.cmdChip.hidden = true;
    d.chips.dataset.fading = '';
    fadeTimer = window.setTimeout(() => { d.chips.hidden = true; delete d.chips.dataset.fading; fadeTimer = null; }, 200);
  };

  d.input.addEventListener('input', render);
  d.input.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const msg = parseMessage(d.input.value);
      if (msg) { clear(); await d.onMessage(msg); return; }
      if (d.input.value.trimStart().startsWith('>')) return; // "> " alone: nothing to say yet
      const cmd = parseCommand(d.input.value);
      if (cmd) { clear(); await d.onCommand(cmd); return; }
      const p = parseLine(d.input.value, { defaultTime: d.defaultTime() });
      if (!p.valid) return;
      d.input.disabled = true;
      try { await d.onCommit(p); clear(); }
      finally { d.input.disabled = false; d.input.focus(); }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (d.input.value) clear(); else d.input.blur();
    }
  });

  return {
    focus: () => { d.input.focus(); d.input.select(); },
    refresh: render,
  };
}
