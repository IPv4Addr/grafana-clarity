import { LiveChannelConnectionState, LiveChannelEvent, LiveChannelEventType, LiveChannelScope } from '@grafana/data';
import { ReplaySubject, of } from 'rxjs';
import { grafana } from '../test/grafana';
import { CUT_OFF, LLM_APP, MAX_STEPS, Message, ask, friendlyError } from './llm';
import { SYSTEM, context } from './prompt';
import { TOOLS } from './tools';

// The model call runs over a fake Grafana Live stream (grafana.live). The events have the shapes grafana-llm-app
// 1.1.0 streams on Grafana 13.2.2: status events, Chat Completions chunks, a usage chunk and its own end marker.

const NOW = Date.parse('2026-09-30T12:00:00Z');
// setTimeout stays real for tick(); the frozen clock makes context() repeatable
beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout'] }));
afterEach(() => jest.useRealTimers());

const status = (state: LiveChannelConnectionState, error?: string): LiveChannelEvent => ({
  type: LiveChannelEventType.Status,
  id: `plugin/${LLM_APP}/llm/v1/chat/completions/1`,
  timestamp: NOW,
  state,
  ...(error && { error }),
});
const message = (m: object): LiveChannelEvent => ({ type: LiveChannelEventType.Message, message: m });
const connected = [status(LiveChannelConnectionState.Connecting), status(LiveChannelConnectionState.Connected)];
const chunk = (delta: object, finish: string | null = null) =>
  message({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
const usage = message({
  choices: [],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    prompt_tokens_details: { cached_tokens: 400 },
  },
});
const done = message({ choices: [{ delta: { done: true } }] });
const NOT_FOUND =
  'establish chat completions stream: error, status code: 404, status: 404 Not Found, message: bad-model is not a valid model ID';

/** A whole model call: connecting, the role, these deltas, the finish reason, the usage and the end marker. */
const turn = (deltas: object[], finish = 'stop') => [
  ...connected,
  chunk({ role: 'assistant' }),
  ...deltas.map((d) => chunk(d)),
  chunk({}, finish),
  usage,
  done,
];
const answer = (text: string) => turn([{ content: text }]);
/** The first piece of a tool call (id and name) and the pieces of its arguments, as the LLM app streams them. */
const toolCall = (index: number | undefined, id: string, name: string, ...args: string[]) => {
  const at = index === undefined ? {} : { index };
  return [
    { tool_calls: [{ ...at, id, type: 'function', function: { name } }] },
    ...args.map((a) => ({ tool_calls: [{ ...at, type: '', function: { arguments: a } }] })),
  ];
};

const tick = () => new Promise((resolve) => setTimeout(resolve));

/** Waits for the n-th model call, streams these events into it and returns its request as it was sent. */
const reply = async (n: number, events: LiveChannelEvent[]) => {
  for (let i = 0; !grafana.live.streams[n]; i++) {
    if (i === 50) {
      throw new Error(`model call ${n} did not start`);
    }
    await tick();
  }
  // the messages are the live history: copy them before the run goes on
  const request = JSON.parse(JSON.stringify(grafana.live.getStream.mock.calls[n][0]));
  events.forEach((e) => grafana.live.streams[n].next(e));
  return request;
};

const fakeUI = () => ({
  usage: jest.fn(),
  text: jest.fn(),
  progress: jest.fn(),
  toolCall: jest.fn(),
  toolResult: jest.fn(),
});

/** Starts ask() on `history`. */
const start = (question: string, history: Message[] = []) => {
  const ui = fakeUI();
  const stop = new AbortController();
  return { run: ask(history, question, ui, stop.signal), ui, stop, history };
};

/** Answers the label requests of list_loki_labels and list_prometheus_labels. */
const fakeLabels = () =>
  grafana.backend.get.mockImplementation(async (url: string) => {
    switch (url) {
      case '/api/datasources/uid/loki/resources/labels':
        return { status: 'success', data: ['service_name', 'level'] };
      case '/api/datasources/uid/prometheus/resources/api/v1/labels':
        return { status: 'success', data: ['job'] };
    }
    return grafana.notFaked(url);
  });

const user = (question: string): Message => ({
  role: 'user',
  content: `<context>\n${context()}\n</context>\n\n${question}`,
});

describe('ask', () => {
  it('runs the tool calls the model asks for and sends the results back until it answers', async () => {
    fakeLabels();
    const { run, ui, history } = start('Which labels are there?');
    const first = await reply(
      0,
      turn(
        [
          { content: 'Checking the labels.' },
          ...toolCall(0, 'call_1_0', 'list_loki_labels', '{"datasourceUid":', '"loki"}'),
          // without an index: a piece with an id starts a call, one without continues the last
          ...toolCall(undefined, 'call_1_1', 'list_prometheus_labels', '{"datasourceUid":"prometheus"}'),
        ],
        'tool_calls'
      )
    );
    const second = await reply(1, answer('Loki has level and service_name, Prometheus has job.'));
    await expect(run).resolves.toBeUndefined();

    const calls: NonNullable<Message['tool_calls']> = [
      {
        id: 'call_1_0',
        type: 'function',
        function: { name: 'list_loki_labels', arguments: '{"datasourceUid":"loki"}' },
      },
      {
        id: 'call_1_1',
        type: 'function',
        function: { name: 'list_prometheus_labels', arguments: '{"datasourceUid":"prometheus"}' },
      },
    ];
    const asked: Message[] = [{ role: 'system', content: SYSTEM }, user('Which labels are there?')];
    const toolTurn: Message[] = [
      { role: 'assistant', content: 'Checking the labels.', tool_calls: calls },
      { role: 'tool', tool_call_id: 'call_1_0', content: 'Label names: 2 values: level, service_name' },
      { role: 'tool', tool_call_id: 'call_1_1', content: 'Label names: 1 values: job' },
    ];
    expect(first).toEqual({
      scope: LiveChannelScope.Plugin,
      stream: 'grafana-llm-app',
      path: expect.stringMatching(/^llm\/v1\/chat\/completions\/\S+$/),
      data: { model: 'large', messages: asked, tools: TOOLS, stream_options: { include_usage: true } },
    });
    expect(second.data.messages).toEqual([...asked, ...toolTurn]);
    expect(second.path).not.toBe(first.path); // a new channel per call
    expect(history).toEqual([
      ...asked,
      ...toolTurn,
      { role: 'assistant', content: 'Loki has level and service_name, Prometheus has job.' },
    ]);

    const loki = { id: 'call_1_0', name: 'list_loki_labels', input: { datasourceUid: 'loki' } };
    const prom = { id: 'call_1_1', name: 'list_prometheus_labels', input: { datasourceUid: 'prometheus' } };
    expect(ui.toolCall.mock.calls.map(([c]) => c)).toEqual([loki, prom]);
    expect(ui.toolResult.mock.calls).toEqual([
      [loki, { forModel: 'Label names: 2 values: level, service_name' }],
      [prom, { forModel: 'Label names: 1 values: job' }],
    ]);
    expect(ui.text.mock.calls).toEqual([
      ['Checking the labels.'],
      ['Loki has level and service_name, Prometheus has job.'],
    ]);
    expect(ui.usage.mock.calls).toEqual([
      [{ model: 'mock-model', input: 1000, output: 100, cached: 400 }],
      [{ model: 'mock-model', input: 1000, output: 100, cached: 400 }],
    ]);
    expect(grafana.live.streams.every((s) => !s.observed)).toBe(true); // unsubscribed after each end marker
  });

  it('streams the text and starts a new progress note for the reasoning of each model call', async () => {
    fakeLabels();
    const { run, ui } = start('q');
    await reply(
      0,
      turn(
        [
          { reasoning_content: 'Look at ' },
          { reasoning_content: 'the labels.' },
          ...toolCall(0, 'call_1_0', 'list_loki_labels', '{"datasourceUid":"loki"}'),
        ],
        'tool_calls'
      )
    );
    await reply(1, turn([{ reasoning_content: 'Enough.' }, { content: 'All ' }, { content: 'good.' }]));
    await run;
    expect(ui.progress.mock.calls).toEqual([
      ['Look at ', true],
      ['the labels.', false],
      ['Enough.', true],
    ]);
    expect(ui.text.mock.calls).toEqual([['All '], ['good.']]);
  });

  it('reports the usage without cached tokens, and without a model name when no chunk had one', async () => {
    const { run, ui } = start('q');
    await reply(0, [
      ...connected,
      message({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
      message({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
      done,
    ]);
    await run;
    expect(ui.usage.mock.calls).toEqual([[{ model: '', input: 10, output: 2, cached: 0 }]]);
  });

  it('ends on a refusal, drops the question from the history and does not offer Continue', async () => {
    const earlier: Message[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ];
    const { run, history } = start('q', [...earlier]);
    await reply(0, turn([{ refusal: 'I cannot ' }, { refusal: 'help with that.' }]));
    await expect(run).resolves.toEqual({ text: 'I cannot help with that.', resumable: false });
    expect(history).toEqual(earlier);
  });

  it('ends on the content filter, also after tool calls, and rewinds the history', async () => {
    fakeLabels();
    const { run, history } = start('q');
    await reply(0, turn(toolCall(0, 'call_1_0', 'list_loki_labels', '{"datasourceUid":"loki"}'), 'tool_calls'));
    await reply(1, turn([{ content: 'Half an' }], 'content_filter'));
    await expect(run).resolves.toEqual({
      text: 'The model declined this request (content filter).',
      resumable: false,
    });
    expect(history).toEqual([]);
  });

  it('never runs tool calls cut off by the output limit', async () => {
    const { run, ui, history } = start('q');
    await reply(0, turn(toolCall(0, 'call_1_0', 'list_loki_labels', '{"datasourceUid":"lo'), 'length'));
    await expect(run).resolves.toBe(CUT_OFF);
    expect(ui.toolCall).not.toHaveBeenCalled();
    expect(grafana.backend.get).not.toHaveBeenCalled();
    expect(history).toEqual([{ role: 'system', content: SYSTEM }, user('q')]);
  });

  it('keeps an answer cut off by the output limit, for Continue', async () => {
    const { run, history } = start('q');
    await reply(0, turn([{ content: 'The p95 is' }], 'length'));
    await expect(run).resolves.toBe(CUT_OFF);
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'The p95 is' });
  });

  it('keeps no empty answer in the history, which would get every later request rejected', async () => {
    const { run, ui, history } = start('q');
    await reply(0, turn([{ reasoning_content: 'Thinking about' }], 'length'));
    await expect(run).resolves.toBe(CUT_OFF);
    expect(ui.progress).toHaveBeenCalledWith('Thinking about', true);
    expect(history).toEqual([{ role: 'system', content: SYSTEM }, user('q')]);
  });

  it('sends arguments that are not valid JSON back to the model as the error of the tool call', async () => {
    const { run, ui, history } = start('q');
    await reply(0, turn(toolCall(0, 'call_1_0', 'get_alerts', '{"states": [firing]}'), 'tool_calls'));
    await reply(1, answer('Sorry, retrying is pointless.'));
    await expect(run).resolves.toBeUndefined();
    const error = 'The tool arguments were not valid JSON: {"states": [firing]}';
    expect(ui.toolResult.mock.calls).toEqual([
      [{ id: 'call_1_0', name: 'get_alerts', input: new Error(error) }, new Error(error)],
    ]);
    expect(history.at(-2)).toEqual({ role: 'tool', tool_call_id: 'call_1_0', content: error });
    expect(grafana.backend.get).not.toHaveBeenCalled();
  });

  it("rejects with the LLM app's error message, which no end marker follows", async () => {
    const { run } = start('q');
    await reply(0, [...connected, message({ error: NOT_FOUND })]);
    const error = await run.catch((e) => e);
    expect(error).toEqual(new Error(NOT_FOUND));
    expect(friendlyError(error)).toBe(
      'Model not found (404): bad-model is not a valid model ID. Check the models set in the Grafana LLM app.'
    );
    expect(grafana.live.streams[0].observed).toBe(false);
  });

  it('rejects when the channel reports an error', async () => {
    const { run } = start('q');
    await reply(0, [status(LiveChannelConnectionState.Connecting, 'permission denied')]);
    await expect(run).rejects.toEqual(new Error('permission denied'));
    expect(grafana.live.streams[0].observed).toBe(false);
  });

  it.each([
    ['an Error', new Error('websocket closed'), new Error('websocket closed')],
    ['anything else', 'websocket closed', new Error('websocket closed')],
  ])('rejects when the stream fails with %s', async (_, failure, expected) => {
    const { run } = start('q');
    await reply(0, connected);
    grafana.live.streams[0].error(failure);
    await expect(run).rejects.toEqual(expected);
  });

  it('handles a stream that emits everything while it is subscribed to, and still unsubscribes', async () => {
    const replay = new ReplaySubject<LiveChannelEvent>(); // replays on subscribe and stays open
    answer('Hi').forEach((e) => replay.next(e));
    grafana.live.getStream.mockImplementationOnce(() => replay);
    const { run, ui, history } = start('q');
    await expect(run).resolves.toBeUndefined();
    expect(ui.text).toHaveBeenCalledWith('Hi');
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'Hi' });
    expect(replay.observed).toBe(false);

    grafana.live.getStream.mockImplementationOnce(() => of(...connected, message({ error: NOT_FOUND })));
    await expect(start('q').run).rejects.toEqual(new Error(NOT_FOUND));
  });

  it('does not start when stopped already', async () => {
    const stop = new AbortController();
    stop.abort();
    const error = await ask([], 'q', fakeUI(), stop.signal).catch((e) => e);
    expect(error.name).toBe('AbortError');
    expect(friendlyError(error)).toBe('Stopped.');
    expect(grafana.live.getStream).not.toHaveBeenCalled();
  });

  it('stops a stream: rejects with an AbortError and unsubscribes', async () => {
    const { run, ui, stop, history } = start('q');
    await reply(0, [...connected, chunk({ role: 'assistant' }), chunk({ content: 'So far' })]);
    expect(grafana.live.streams[0].observed).toBe(true);
    stop.abort();
    const error = await run.catch((e) => e);
    expect(error.name).toBe('AbortError');
    expect(friendlyError(error)).toBe('Stopped.');
    expect(grafana.live.streams[0].observed).toBe(false);
    expect(ui.text).toHaveBeenCalledWith('So far');
    expect(history).toEqual([{ role: 'system', content: SYSTEM }, user('q')]);
  });

  it('stops while tools run: every tool call keeps a result and no model call follows', async () => {
    // a tool request that only ends when it is aborted
    grafana.backend.get.mockImplementation(
      (_url: string, _params: unknown, _id: unknown, options: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => options.abortSignal.addEventListener('abort', () => reject(new Error('aborted'))))
    );
    const { run, stop, history } = start('q');
    await reply(0, turn(toolCall(0, 'call_1_0', 'list_loki_labels', '{"datasourceUid":"loki"}'), 'tool_calls'));
    await tick();
    stop.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(history.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_1_0',
      content: 'Stopped by the user before this finished.',
    });
    expect(grafana.live.getStream).toHaveBeenCalledTimes(1);
  });

  it(`gives up after ${MAX_STEPS} model calls without an answer`, async () => {
    fakeLabels();
    const { run, history } = start('q');
    run.catch(() => {}); // it rejects before the test awaits it
    for (let n = 0; n < MAX_STEPS; n++) {
      await reply(n, turn(toolCall(0, `call_${n}`, 'list_loki_labels', '{"datasourceUid":"loki"}'), 'tool_calls'));
    }
    await expect(run).rejects.toThrow(`Stopped after ${MAX_STEPS} steps without a final answer.`);
    expect(grafana.live.getStream).toHaveBeenCalledTimes(MAX_STEPS);
    expect(history).toHaveLength(2 + 2 * MAX_STEPS);
  });
});

describe('friendlyError', () => {
  it.each([
    [
      'error, status code: 401, status: 401 Unauthorized, message: invalid x-api-key',
      'The model provider rejected the request (401): invalid x-api-key. Check the API key in the Grafana LLM app.',
    ],
    [
      'error, status code: 403, status: 403 Forbidden, message: no access\nto this model',
      'The model provider rejected the request (403): no access\nto this model. Check the API key in the Grafana LLM app.',
    ],
    [
      NOT_FOUND,
      'Model not found (404): bad-model is not a valid model ID. Check the models set in the Grafana LLM app.',
    ],
    [
      'error, status code: 429, status: 429 Too Many Requests, message: rate limit exceeded',
      'The model provider is rate limiting requests. Try again in a moment.',
    ],
    [
      'error, status code: 500, status: 500 Internal Server Error, message: overloaded',
      'Model API error 500: overloaded',
    ],
    ['error, status code: 502, status: 502 Bad Gateway', 'Model API error 502: Bad Gateway'],
    ['error, Provider returned error', 'Provider returned error'], // an error in the middle of a stream
    ['the model said no', 'the model said no'],
  ])('%p', (message, friendly) => {
    expect(friendlyError(new Error(message))).toBe(friendly);
  });

  it.each([
    'Post "https://api.openai.com/v1/chat/completions": dial tcp: lookup api.openai.com: no such host',
    'Post "http://ollama:11434/v1/chat/completions": dial tcp 10.0.0.5:11434: connect: connection refused',
    'Post "http://ollama:11434/v1/chat/completions": context deadline exceeded',
    'net/http: TLS handshake timeout',
  ])('says the provider is unreachable: %p', (message) => {
    expect(friendlyError(new Error(message))).toBe(
      `The Grafana LLM app could not reach the model provider: ${message}`
    );
  });

  it('takes anything thrown, and reads an abort as "Stopped."', () => {
    expect(friendlyError('boom')).toBe('boom');
    expect(friendlyError(new DOMException('The operation was aborted.', 'AbortError'))).toBe('Stopped.');
  });
});

describe('llmStatus', () => {
  /** llmStatus of a freshly loaded llm.ts, since it checks once per page load. */
  const loadStatus = async () => {
    let llm!: typeof import('./llm');
    await jest.isolateModulesAsync(async () => {
      llm = await import('./llm');
    });
    return llm.llmStatus;
  };

  /** Answers the LLM app's settings and health requests; a missing one fails like a missing plugin. */
  const respond = (answers: { settings?: () => unknown; health?: () => unknown }) =>
    grafana.backend.get.mockImplementation(async (url: string) => {
      const answer = answers[url.replace(`/api/plugins/${LLM_APP}/`, '') as 'settings' | 'health'];
      return answer ? answer() : grafana.notFaked(url);
    });
  const enabled = () => ({ enabled: true });
  const provider = (llmProvider: object) => () => ({ status: 'OK', details: { llmProvider } });

  it('is ok when the LLM app is enabled and its provider works, and checks only once', async () => {
    respond({ settings: enabled, health: provider({ configured: true, ok: true }) });
    const llmStatus = await loadStatus();
    await expect(llmStatus()).resolves.toEqual({ ok: true });
    await expect(llmStatus()).resolves.toEqual({ ok: true });
    expect(grafana.backend.get.mock.calls).toEqual([
      [`/api/plugins/${LLM_APP}/settings`, undefined, undefined, { showErrorAlert: false }],
      [`/api/plugins/${LLM_APP}/health`, undefined, undefined, { showErrorAlert: false }],
    ]);
  });

  it.each([
    ['it is not installed', {}, 'The Grafana LLM app is not installed.'],
    ['it is disabled', { settings: () => ({ enabled: false }) }, 'The Grafana LLM app is not enabled.'],
    [
      'its provider does not work',
      { settings: enabled, health: provider({ configured: true, ok: false, error: 'invalid API key' }) },
      'invalid API key',
    ],
    [
      'no provider is set up',
      { settings: enabled, health: provider({ configured: false, ok: false }) },
      'No LLM provider is set up yet.',
    ],
    [
      'its health check fails',
      {
        settings: enabled,
        health: () => Promise.reject({ status: 500, data: { message: 'plugin unavailable' } }),
      },
      'The Grafana LLM app health check failed: plugin unavailable',
    ],
  ])('says what the admin has to do when %s', async (_, answers, error) => {
    respond(answers);
    await expect((await loadStatus())()).resolves.toEqual({ ok: false, error });
  });
});
