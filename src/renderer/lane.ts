/**
 * The talk lane — the channel between the user and whatever agent is connected
 * over MCP. The user types `> …` in the bar; the agent reads with
 * `list_messages` and answers with `send_message`. Both sides write the same
 * notes.json, so the existing watcher delivers replies with no new plumbing.
 *
 * Everything here is DATA rendered as text. Message text is inserted with
 * textContent only — an agent's reply is never treated as markup, and never as
 * an instruction to this app.
 */
import type { Message } from '../shared/types';

export interface LaneDeps {
  root: HTMLElement;
  log: HTMLElement;
  hint: HTMLElement;
  toggle: HTMLElement;
  clear: HTMLElement;
  rail: HTMLElement;
}

export class Lane {
  private messages: Message[] = [];
  private open = false;
  /** True between sending and the agent's next reply — drives the breathing hint. */
  private awaiting = false;
  /** True while the built-in assistant is actually mid-call. */
  private thinking = false;

  constructor(private d: LaneDeps) {
    d.toggle.addEventListener('click', () => this.setOpen(!this.open));
    d.clear.addEventListener('click', async () => {
      await window.pyre.clearMessages();
      this.setOpen(false);
    });
  }

  setMessages(list: Message[]): void {
    const hadAgentReply = this.messages.some((m) => m.role === 'agent');
    this.messages = list;
    const agentReplied = list.some((m) => m.role === 'agent');
    // A fresh reply arrived: stop breathing, and surface the lane.
    if (agentReplied && (!hadAgentReply || list.length > 0)) {
      const last = list[list.length - 1];
      if (last && last.role === 'agent' && !last.read) {
        this.awaiting = false;
        // Open on a fresh reply. If it is ALREADY open the reply has been seen
        // the moment it rendered, so clear the unread flag rather than leaving
        // a count sitting over a message the user is looking at.
        if (!this.open) this.setOpen(true);
        else void window.pyre.markMessagesRead();
      }
    }
    this.render();
  }

  /** The built-in assistant is mid-call. */
  setThinking(v: boolean): void {
    this.thinking = v;
    if (v) { this.awaiting = true; this.setOpen(true); }
    this.render();
  }

  /** Called when the user sends, so the lane opens and shows it is waiting. */
  markAwaiting(): void {
    this.awaiting = true;
    this.setOpen(true);
    this.render();
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.d.root.hidden = !open || this.messages.length === 0;
    this.d.toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      void window.pyre.markMessagesRead();
      this.scrollToEnd();
    }
    this.render();
  }

  private scrollToEnd(): void {
    requestAnimationFrame(() => { this.d.log.scrollTop = this.d.log.scrollHeight; });
  }

  private render(): void {
    const list = this.messages;
    const unread = list.filter((m) => m.role === 'agent' && !m.read).length;

    // The TALK button only exists once there is a conversation.
    this.d.toggle.hidden = list.length === 0;
    this.d.toggle.textContent = unread ? `TALK ${unread}` : 'TALK';
    if (unread) this.d.toggle.dataset.unread = ''; else delete this.d.toggle.dataset.unread;
    this.d.toggle.title = list.length
      ? `${list.length} message${list.length === 1 ? '' : 's'} with the connected agent`
      : 'Type > in the bar to say something';

    this.d.root.hidden = !this.open || list.length === 0;
    if (this.d.root.hidden) return;

    const atEnd = this.d.log.scrollHeight - this.d.log.scrollTop - this.d.log.clientHeight < 24;
    this.d.log.replaceChildren();
    for (const m of list) {
      const el = document.createElement('div');
      el.className = 'msg';
      el.dataset.role = m.role;
      if (m.role === 'user' && !m.read) el.dataset.unread = '';
      // textContent: agent output is data, never markup.
      el.textContent = m.text;
      const when = document.createElement('span');
      when.className = 'msg__when';
      when.textContent = relative(m.created);
      el.appendChild(when);
      this.d.log.appendChild(el);
    }

    const pendingFromUser = list.some((m) => m.role === 'user' && !m.read);
    if (this.thinking) {
      this.d.hint.textContent = 'THINKING…';
      this.d.hint.classList.add('lane__pending');
    } else if (this.awaiting || pendingFromUser) {
      this.d.hint.textContent = 'WAITING FOR THE AGENT TO LOOK';
      this.d.hint.classList.add('lane__pending');
    } else {
      this.d.hint.classList.remove('lane__pending');
      this.d.hint.innerHTML = 'Type <b>&gt;</b> in the bar to say something';
    }

    if (atEnd) this.scrollToEnd();
  }
}

function relative(iso: string): string {
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 1) return 'now';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}
