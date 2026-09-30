import { useSyncExternalStore } from 'react';
import { Message, ask, friendlyError } from './llm';
import { RESUME } from './prompt';
import { ToolOutcome, describeCall } from './tools';

// One conversation per browser tab, kept outside React so it survives going to Explore or a dashboard and back.

/** One entry in the chat. `interrupted`: a half-streamed answer or note; `info`: a notice, not an error (Stop). */
export type Item =
  | { kind: 'user' | 'assistant' | 'progress' | 'error' | 'usage'; text: string; interrupted?: boolean; info?: boolean }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; result?: ToolOutcome; error?: string };

interface State {
  items: Item[];
  busy: boolean;
  /** the last run was interrupted and can be continued from the history */
  resumable: boolean;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const usageLine = (t: { model: string; calls: number; input: number; output: number; cached: number }) =>
  [
    ...(t.model ? [t.model] : []),
    `${t.calls} model call${t.calls === 1 ? '' : 's'}`,
    `${k(t.input)} tokens in${t.cached ? ` (${k(t.cached)} cached)` : ''}`,
    `${k(t.output)} out`,
  ].join(' · ');

/**
 * The conversation: what the chat shows (a snapshot for useSyncExternalStore) and the history sent to the model.
 * One question runs at a time.
 */
export class ChatStore {
  private state: State = { items: [], busy: false, resumable: false };
  private history: Message[] = [];
  private controller?: AbortController;
  private listeners = new Set<() => void>();
  private notifyScheduled = false;

  /** `run` asks the model (llm.ts); tests pass a fake. */
  constructor(private readonly run: typeof ask = ask) {}

  // subscribe, getSnapshot, stop and reset are arrow fields because they are passed unbound
  // (useSyncExternalStore(chat.subscribe, chat.getSnapshot), onClick={chat.reset}); the rest are methods.

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The current state. Replaced on every change, never mutated. */
  getSnapshot = () => this.state;

  /** Asks a question, unless one is running. `label` is what the chat shows instead, e.g. for the long panel-menu prompt. */
  async send(question: string, label?: string) {
    if (this.state.busy || !question.trim()) {
      return;
    }
    const mine = (this.controller = new AbortController()); // reset() replaces it; a stale run then stays silent
    this.set((s) => ({ busy: true, resumable: false, items: [...s.items, { kind: 'user', text: label ?? question }] }));
    const total = { model: '', calls: 0, input: 0, output: 0, cached: 0 };
    try {
      const notice = await this.run(
        this.history,
        question,
        {
          usage: (u) => {
            total.model = u.model || total.model;
            total.calls++;
            total.input += u.input;
            total.output += u.output;
            total.cached += u.cached;
          },
          text: (d) => this.appendText('assistant', d),
          progress: (d, newBlock) =>
            newBlock ? this.push({ kind: 'progress', text: d }) : this.appendText('progress', d),
          toolCall: (c) =>
            this.push({ kind: 'tool', id: c.id, name: c.name, input: c.input as Record<string, unknown> }),
          toolResult: (c, out) =>
            this.set((s) => ({
              items: s.items.map((i) =>
                i.kind === 'tool' && i.id === c.id
                  ? { ...i, ...(out instanceof Error ? { error: out.message } : { result: out }) }
                  : i
              ),
            })),
        },
        mine.signal
      );
      if (notice) {
        this.interrupted(notice.text, notice.resumable);
      }
    } catch (e) {
      if (this.controller === mine) {
        // everything that completed (model turns, tool results) is in the history, so Continue can pick up from there
        this.interrupted(friendlyError(e), true, mine.signal.aborted);
      }
    } finally {
      if (this.controller === mine) {
        if (total.calls) {
          this.push({ kind: 'usage', text: usageLine(total) });
        }
        this.set(() => ({ busy: false }));
      }
    }
  }

  /** Continue after Stop, a network or API error, the step limit or a cut-off answer. */
  resume() {
    return this.send(RESUME, 'Continue');
  }

  stop = () => this.controller?.abort();

  /** Starts a new conversation. A run still in progress is stopped and no longer updates the chat. */
  reset = () => {
    this.stop();
    this.controller = undefined;
    this.history = [];
    this.set(() => ({ items: [], busy: false, resumable: false }));
  };

  private set(update: (s: State) => Partial<State>) {
    this.state = { ...this.state, ...update(this.state) };
    // One React update per task, not per streamed token: a burst of tiny chunks otherwise chains synchronous
    // renders until React gives up ("Maximum update depth exceeded"), and a render error must not abort the stream.
    if (!this.notifyScheduled) {
      this.notifyScheduled = true;
      setTimeout(() => {
        this.notifyScheduled = false;
        this.listeners.forEach((l) => l());
      });
    }
  }

  private push(item: Item) {
    this.set((s) => ({ items: [...s.items, item] }));
  }

  private appendText(kind: 'assistant' | 'progress', delta: string) {
    this.set((s) => {
      const last = s.items[s.items.length - 1];
      return last?.kind === kind
        ? { items: [...s.items.slice(0, -1), { kind, text: last.text + delta }] }
        : { items: [...s.items, { kind, text: delta }] };
    });
  }

  /** `info`: the user stopped it, so it is not shown as an error */
  private interrupted(text: string, resumable: boolean, info = false) {
    this.set((s) => {
      const last = s.items[s.items.length - 1];
      // a half-streamed answer must not read as the final one
      const items =
        last?.kind === 'assistant' || last?.kind === 'progress'
          ? [...s.items.slice(0, -1), { ...last, interrupted: true }]
          : s.items;
      return { items: [...items, { kind: 'error', text, info }], resumable };
    });
  }
}

/** The conversation of this browser tab. */
export const chat = new ChatStore();

/** The chat state, re-rendering on changes. */
export const useChat = () => useSyncExternalStore(chat.subscribe, chat.getSnapshot);

// The model ends an answer with "Follow-ups: a | b | c" (see prompt.ts); shown as buttons, not as text.
const FOLLOW_UPS = /(?:^|\n)[ \t]*[*_]*follow-?ups?[*_]*[ \t]*:[*_]*([^\n]*)$/i;

/** Splits the trailing "Follow-ups:" line off an answer, into at most three questions. */
export const splitFollowUps = (text: string): { body: string; followUps: string[] } => {
  const m = text.match(FOLLOW_UPS);
  if (!m) {
    return { body: text, followUps: [] };
  }
  const followUps = m[1]
    .split('|')
    .map((q) => q.replace(/[*_`]+/g, '').trim())
    .filter(Boolean)
    .slice(0, 3);
  return { body: text.slice(0, m.index).trimEnd(), followUps };
};

/** The conversation as Markdown, e.g. for an incident channel or a postmortem. */
export const transcript = (items: Item[]): string =>
  items
    .map((i) => {
      switch (i.kind) {
        case 'user':
          return `## ${i.text}`;
        case 'assistant':
          return splitFollowUps(i.text).body + (i.interrupted ? ' _(interrupted)_' : '');
        case 'tool': {
          const { title, code } = describeCall(i.name, i.input);
          const explore = i.result?.view?.explore;
          return `- ${title}${code ? `: \`${code.replace(/\s+/g, ' ')}\`` : ''}${
            explore ? ` ([Explore](${new URL(explore, document.baseURI).href}))` : ''
          }${i.error ? ` failed: ${i.error}` : ''}`;
        }
        case 'error':
          return `> ${i.text}`;
        case 'usage':
          return `_${i.text}_`;
        default:
          return ''; // progress notes
      }
    })
    .filter(Boolean)
    .join('\n\n');
