import { CUT_OFF, ask } from './llm';
import { RESUME } from './prompt';
import { ChatStore, splitFollowUps, transcript } from './store';

/** A store that runs `run` instead of asking the model. */
const setup = (run: typeof ask) => {
  const fake = jest.fn(run);
  return { store: new ChatStore(fake), ask: fake };
};

/** Rejects with the abort reason (an AbortError) once the run is stopped, as ask does. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

/** Lets pending promises settle and the batched listener notification fire. */
const tick = () => new Promise((resolve) => setTimeout(resolve));

describe('ChatStore', () => {
  it('shows the question and streams the answer', async () => {
    const { store, ask } = setup(async (_history, _question, ui) => {
      ui.text('Payments ');
      ui.text('is up.');
      return undefined;
    });
    await store.send('Is payments up?');
    const [history, question, , signal] = ask.mock.calls[0];
    expect([history, question, signal.aborted]).toEqual([[], 'Is payments up?', false]);
    expect(store.getSnapshot()).toEqual({
      busy: false,
      resumable: false,
      items: [
        { kind: 'user', text: 'Is payments up?' },
        { kind: 'assistant', text: 'Payments is up.' },
      ],
    });
  });

  it('shows the label instead of the question, but sends the question', async () => {
    const { store, ask } = setup(async () => undefined);
    await store.send('A long prompt with the panel JSON', 'Explain this panel');
    expect(ask.mock.calls[0][1]).toBe('A long prompt with the panel JSON');
    expect(store.getSnapshot().items).toEqual([{ kind: 'user', text: 'Explain this panel' }]);
  });

  it('starts a new progress note per block and puts the answer after the notes', async () => {
    const { store } = setup(async (_history, _question, ui) => {
      ui.progress('Checking ', true);
      ui.progress('alerts', false);
      ui.progress('Querying', true);
      ui.text('All ');
      ui.text('good.');
      return undefined;
    });
    await store.send('q');
    expect(store.getSnapshot().items.slice(1)).toEqual([
      { kind: 'progress', text: 'Checking alerts' },
      { kind: 'progress', text: 'Querying' },
      { kind: 'assistant', text: 'All good.' },
    ]);
  });

  it('fills in the result or the error of the matching tool call', async () => {
    const outcome = { forModel: '1 series' };
    const { store } = setup(async (_history, _question, ui) => {
      const prom = { id: 'a', name: 'query_prometheus', input: { expr: 'up' } };
      const loki = { id: 'b', name: 'query_loki', input: { logql: '{app="x"' } };
      ui.toolCall(prom);
      ui.toolCall(loki);
      ui.toolResult(loki, new Error('parse error'));
      ui.toolResult(prom, outcome);
      return undefined;
    });
    await store.send('q');
    expect(store.getSnapshot().items.slice(1)).toEqual([
      { kind: 'tool', id: 'a', name: 'query_prometheus', input: { expr: 'up' }, result: outcome },
      { kind: 'tool', id: 'b', name: 'query_loki', input: { logql: '{app="x"' }, error: 'parse error' },
    ]);
  });

  it('ends with a usage line: model, calls, tokens in thousands, cache hits', async () => {
    const { store } = setup(async (_history, _question, ui) => {
      ui.usage({ model: '', input: 1500, output: 200, cached: 1000 });
      ui.usage({ model: 'gpt-4o', input: 800, output: 50, cached: 0 });
      return undefined;
    });
    await store.send('q');
    expect(store.getSnapshot().items.at(-1)).toEqual({
      kind: 'usage',
      text: 'gpt-4o · 2 model calls · 2.3k tokens in (1.0k cached) · 250 out',
    });
  });

  it('leaves the model out of the usage line when the stream did not name it', async () => {
    const { store } = setup(async (_history, _question, ui) => {
      ui.usage({ model: '', input: 999, output: 5, cached: 0 });
      return undefined;
    });
    await store.send('q');
    expect(store.getSnapshot().items.at(-1)).toEqual({ kind: 'usage', text: '1 model call · 999 tokens in · 5 out' });
  });

  it('adds no usage line without model calls', async () => {
    const { store } = setup(async (_history, _question, ui) => {
      ui.text('ok');
      return undefined;
    });
    await store.send('q');
    expect(store.getSnapshot().items.map((i) => i.kind)).toEqual(['user', 'assistant']);
  });

  it('is busy while a question runs, and ignores empty questions and a second question', async () => {
    let answer!: () => void;
    const { store, ask } = setup(() => new Promise((resolve) => (answer = () => resolve(undefined))));
    await store.send(' \n ');
    expect(store.getSnapshot().items).toEqual([]);

    const first = store.send('first');
    expect(store.getSnapshot().busy).toBe(true);
    await store.send('second');
    await tick();
    answer();
    await first;
    expect(ask).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ busy: false, resumable: false, items: [{ kind: 'user', text: 'first' }] });
  });

  it('notifies listeners once per task, not per streamed token', async () => {
    const { store } = setup(async (_history, _question, ui) => {
      for (let i = 0; i < 100; i++) {
        ui.text('x');
      }
      return undefined;
    });
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    await store.send('q');
    expect(listener).not.toHaveBeenCalled();
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().items[1]).toEqual({ kind: 'assistant', text: 'x'.repeat(100) });

    unsubscribe();
    store.reset();
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the snapshot until something changes, and never mutates it', async () => {
    const { store } = setup(async (_history, _question, ui) => {
      ui.text('a');
      return undefined;
    });
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    await store.send('q');
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(store.getSnapshot()).toBe(after);
    expect(before).toEqual({ items: [], busy: false, resumable: false });
  });

  it('ends the run on a notice and marks the half-written answer', async () => {
    const { store } = setup(async (_history, _question, ui) => {
      ui.text('The p95 is');
      return CUT_OFF;
    });
    await store.send('q');
    expect(store.getSnapshot()).toEqual({
      busy: false,
      resumable: true,
      items: [
        { kind: 'user', text: 'q' },
        { kind: 'assistant', text: 'The p95 is', interrupted: true },
        { kind: 'error', text: CUT_OFF.text, info: false },
      ],
    });
  });

  it('does not offer Continue after a refusal', async () => {
    const { store } = setup(async () => ({ text: 'The model declined this request.', resumable: false }));
    await store.send('q');
    expect(store.getSnapshot()).toEqual({
      busy: false,
      resumable: false,
      items: [
        { kind: 'user', text: 'q' },
        { kind: 'error', text: 'The model declined this request.', info: false },
      ],
    });
  });

  it('shows the friendly message for an error, keeps the usage and offers Continue', async () => {
    const { store } = setup(async (_history, _question, ui) => {
      ui.usage({ model: 'm', input: 10, output: 5, cached: 0 });
      ui.progress('Checking the error rate', true);
      throw new Error('error, status code: 429, status: 429 Too Many Requests, message: slow down');
    });
    await store.send('q');
    expect(store.getSnapshot()).toEqual({
      busy: false,
      resumable: true,
      items: [
        { kind: 'user', text: 'q' },
        { kind: 'progress', text: 'Checking the error rate', interrupted: true },
        { kind: 'error', text: 'The model provider is rate limiting requests. Try again in a moment.', info: false },
        { kind: 'usage', text: 'm · 1 model call · 10 tokens in · 5 out' },
      ],
    });
  });

  it('stops a run: an info notice, the partial answer marked, Continue offered', async () => {
    const { store } = setup(async (_history, _question, ui, signal) => {
      ui.text('So far');
      return untilAborted(signal);
    });
    const run = store.send('q');
    await tick();
    store.stop();
    await run;
    expect(store.getSnapshot()).toEqual({
      busy: false,
      resumable: true,
      items: [
        { kind: 'user', text: 'q' },
        { kind: 'assistant', text: 'So far', interrupted: true },
        { kind: 'error', text: 'Stopped.', info: true },
      ],
    });
  });

  it('reset clears the chat, and a run from before the reset stays silent', async () => {
    const { store } = setup(async (_history, question, ui, signal) => {
      ui.text(`answer to ${question}`);
      return untilAborted(signal);
    });
    const old = store.send('old');
    await tick();
    store.reset();
    expect(store.getSnapshot()).toEqual({ items: [], busy: false, resumable: false });

    const current = store.send('new');
    await old; // its abort must neither add "Stopped." nor end the new run
    await tick();
    expect(store.getSnapshot()).toEqual({
      busy: true,
      resumable: false,
      items: [
        { kind: 'user', text: 'new' },
        { kind: 'assistant', text: 'answer to new' },
      ],
    });
    store.stop();
    await current;
  });

  it('keeps the history between questions and starts a new one on reset', async () => {
    const { store, ask } = setup(async (history, question) => {
      history.push({ role: 'user', content: question });
      return undefined;
    });
    await store.send('a');
    await store.send('b');
    store.reset();
    await store.send('c');
    const [first, second, third] = ask.mock.calls.map((call) => call[0].map((m) => m.content));
    expect(ask.mock.calls[1][0]).toBe(ask.mock.calls[0][0]);
    expect([first, second, third]).toEqual([['a', 'b'], ['a', 'b'], ['c']]);
  });

  it('resume asks the model to continue, shown as "Continue"', async () => {
    const { store, ask } = setup(async () => undefined);
    await store.resume();
    expect(ask.mock.calls[0][1]).toBe(RESUME);
    expect(store.getSnapshot().items).toEqual([{ kind: 'user', text: 'Continue' }]);
  });
});

describe('splitFollowUps', () => {
  it('takes the last "Follow-ups:" line off the answer', () => {
    expect(splitFollowUps('Payments is down.\n\nFollow-ups: Why is it down? | Since when? | What calls it?')).toEqual({
      body: 'Payments is down.',
      followUps: ['Why is it down?', 'Since when?', 'What calls it?'],
    });
  });

  it('accepts Markdown emphasis and keeps at most three', () => {
    expect(splitFollowUps('Done.\n**Follow-ups:** *A?* | B? | C? | D?').followUps).toEqual(['A?', 'B?', 'C?']);
  });

  it('accepts "Follow-up:" in any case and drops empty questions', () => {
    expect(splitFollowUps('Done.\n  follow-up: `A?` |  | ')).toEqual({ body: 'Done.', followUps: ['A?'] });
  });

  it('hides a line that is still streaming in', () => {
    expect(splitFollowUps('Done.\n\nFollow-ups: Why is')).toEqual({ body: 'Done.', followUps: ['Why is'] });
  });

  it('leaves answers without a final follow-up line alone', () => {
    const text = 'Follow-ups: not the last line\nstill the answer';
    expect(splitFollowUps(text)).toEqual({ body: text, followUps: [] });
  });
});

describe('transcript', () => {
  it('exports questions, queries with absolute Explore links, answers and usage as Markdown', () => {
    const md = transcript([
      { kind: 'user', text: 'Is payments running?' },
      {
        kind: 'tool',
        id: 't1',
        name: 'query_prometheus',
        input: { expr: 'up{job="payments"}' },
        result: { forModel: '', view: { explore: '/explore?x=1' } as any },
      },
      { kind: 'progress', text: 'checking' },
      { kind: 'assistant', text: 'No, it is down.\nFollow-ups: Why?' },
      { kind: 'usage', text: 'm · 1 model call' },
    ]);
    expect(md).toBe(
      [
        '## Is payments running?',
        '- PromQL: `up{job="payments"}` ([Explore](http://localhost:3000/explore?x=1))',
        'No, it is down.',
        '_m · 1 model call_',
      ].join('\n\n')
    );
  });

  it('keeps Explore links absolute under a Grafana sub-path', () => {
    // Grafana's page then has <base href="/<sub-path>/">, and the tool's link starts with the sub-path
    document.head.innerHTML = '<base href="/grafana/">';
    try {
      const md = transcript([
        {
          kind: 'tool',
          id: 't1',
          name: 'query_prometheus',
          input: { expr: 'up' },
          result: { forModel: '', view: { explore: '/grafana/explore?x=1' } as any },
        },
      ]);
      expect(md).toBe('- PromQL: `up` ([Explore](http://localhost:3000/grafana/explore?x=1))');
    } finally {
      document.head.innerHTML = '';
    }
  });

  it('marks failed queries, interrupted answers and notices', () => {
    const md = transcript([
      { kind: 'tool', id: 't1', name: 'get_alerts', input: {} },
      {
        kind: 'tool',
        id: 't2',
        name: 'query_loki',
        input: { datasourceUid: 'loki', logql: '{app="x"}\n  |= "err"' },
        error: 'parse error',
      },
      { kind: 'assistant', text: 'So far\nFollow-ups: A?', interrupted: true },
      { kind: 'error', text: 'Stopped.', info: true },
      { kind: 'error', text: 'Rate limited.' },
    ]);
    expect(md).toBe(
      [
        '- Firing alerts',
        '- LogQL · Loki: `{app="x"} |= "err"` failed: parse error',
        'So far _(interrupted)_',
        '> Stopped.',
        '> Rate limited.',
      ].join('\n\n')
    );
  });

  it('is empty for an empty chat', () => {
    expect(transcript([])).toBe('');
  });
});
