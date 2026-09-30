import { DataFrame, DataQueryResponse, DataTopic, FieldType, LoadingState, createDataFrame } from '@grafana/data';
import { Subject, of, throwError } from 'rxjs';
import { fakeDatasource, grafana } from '../test/grafana';
import { TOOLS, ToolOutcome, describeCall, executeTool } from './tools';

// Every tool runs against the fake @grafana/runtime: the tests check the request sent to Grafana or the datasource,
// the text for the model and the panel the chat renders. The clock is fixed, since time ranges and the model's text
// derive from now.
const NOW = Date.parse('2026-09-30T12:00:00Z');
const HOUR = 3_600_000;
const RANGE = 'Time range 2026-09-30T11:00:00.000Z to 2026-09-30T12:00:00.000Z.';
const signal = new AbortController().signal;

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => jest.useRealTimers());

const run = (name: string, input: Record<string, unknown>) => executeTool(name, input, signal);

/** Answers the datasource query with these frames. */
const respond = (...frames: DataFrame[]) =>
  grafana.query.mockReturnValue(of({ data: frames, state: LoadingState.Done }));

/** The time range (in ms) and query of the one datasource query; also checks it went to that datasource. */
const sentQuery = () => {
  expect(grafana.query).toHaveBeenCalledTimes(1);
  const [request] = grafana.query.mock.calls[0];
  expect(request.targets).toHaveLength(1);
  expect(grafana.query.mock.contexts[0].uid).toBe(request.targets[0].datasource?.uid);
  return {
    from: request.range.from.valueOf(),
    to: request.range.to.valueOf(),
    query: request.targets[0] as Record<string, any>,
  };
};

/** URL and params of the one GET request; also checks that the abort signal is passed on. */
const sentGet = () => {
  expect(grafana.backend.get).toHaveBeenCalledTimes(1);
  const [url, params, , options] = grafana.backend.get.mock.calls[0];
  expect(options).toEqual({ showErrorAlert: false, abortSignal: signal });
  return { url, params };
};

/** The Explore pane an Explore link opens. */
const explorePane = (link?: string) => {
  const url = new URL(link!, 'http://grafana');
  expect(url.pathname).toBe('/explore');
  return JSON.parse(url.searchParams.get('panes')!).llm;
};

/** The values of a column of the panel's first frame. */
const column = (out: ToolOutcome, name: string) => out.view?.frames[0].fields.find((f) => f.name === name)?.values;

/** A Prometheus-style series with a sample per minute, starting an hour ago. */
const series = (labels: Record<string, string>, values: number[]) =>
  createDataFrame({
    refId: 'A',
    fields: [
      { name: 'Time', type: FieldType.time, values: values.map((_, i) => NOW - HOUR + i * 60_000) },
      { name: 'Value', type: FieldType.number, values, labels },
    ],
  });

describe('executeTool', () => {
  it('rejects a tool it does not know', async () => {
    await expect(run('drop_database', {})).rejects.toThrow('Unknown tool drop_database');
  });

  it('runs and titles every tool offered to the model', async () => {
    for (const name of TOOLS.map((t) => t.function.name)) {
      // nothing is faked, so every run fails, but not as an unknown tool
      const error = await executeTool(name, undefined, signal).catch((e) => e);
      expect(error?.message).not.toBe(`Unknown tool ${name}`);
      expect(describeCall(name, {}).title).not.toBe(name);
    }
  });
});

describe('query_prometheus', () => {
  const input = { datasourceUid: 'prometheus', expr: 'up{job="api"}', queryType: 'range', start: 'now-1h', end: 'now' };
  const query = { expr: 'up{job="api"}', instant: false, range: true, editorMode: 'code', legendFormat: '__auto' };

  it('runs a range query and shows it as a time series', async () => {
    const exemplars = createDataFrame({
      refId: 'A',
      meta: { dataTopic: DataTopic.Annotations },
      fields: [{ name: 'Time', type: FieldType.time, values: [NOW] }],
    });
    respond(series({ job: 'api', instance: 'a' }, [1, 0, 1]), exemplars);
    const out = await run('query_prometheus', input);

    expect(sentQuery()).toEqual({
      from: NOW - HOUR,
      to: NOW,
      query: { refId: 'A', datasource: { type: 'prometheus', uid: 'prometheus' }, ...query },
    });
    expect(grafana.query.mock.calls[0][0]).toMatchObject({
      requestId: expect.stringMatching(/^clarity-\d+$/),
      app: 'ipv4addr-clarity-app',
      maxDataPoints: 200,
      interval: '20s', // an hour in 200 points, rounded
      intervalMs: 20_000,
      scopedVars: {},
      timezone: 'utc',
      startTime: NOW,
    });
    expect(
      out.forModel.startsWith(`${RANGE}\n1 series (common labels: {job="api", instance="a"}), sorted by max:\n`)
    ).toBe(true);
    const { frames, timeRange, explore, ...view } = out.view!;
    expect(view).toEqual({ panel: 'timeseries', height: 220 });
    expect(frames).toHaveLength(1); // exemplars are not a series
    expect([timeRange.from.valueOf(), timeRange.to.valueOf()]).toEqual([NOW - HOUR, NOW]);
    expect(explorePane(explore)).toEqual({
      datasource: 'prometheus',
      queries: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'prometheus' }, ...query }],
      range: { from: String(NOW - HOUR), to: String(NOW) },
    });
  });

  it('runs an instant query and shows it as a bar gauge sized to the series', async () => {
    respond(series({ job: 'a' }, [1]), series({ job: 'b' }, [0]));
    const out = await run('query_prometheus', { ...input, queryType: 'instant' });
    expect(sentQuery().query).toMatchObject({ instant: true, range: false });
    expect(out.forModel).toBe(`${RANGE}\n2 series (common labels: {}):\n{job="a"} 1\n{job="b"} 0`);
    expect(out.view).toMatchObject({ panel: 'bargauge', height: 60 + 2 * 28 });
  });

  it("steps no finer than the datasource's minimum interval", async () => {
    respond();
    await run('query_prometheus', { ...input, start: 'now-10m' });
    // 10 minutes in 200 points would be 3s; the Prometheus datasource scrapes every 15s
    expect(grafana.query.mock.calls[0][0]).toMatchObject({ interval: '15s', intervalMs: 15_000 });
  });

  it('gives every query its own request id, or Grafana would cancel one of two parallel queries', async () => {
    respond();
    await Promise.all([run('query_prometheus', input), run('query_prometheus', input)]);
    const [a, b] = grafana.query.mock.calls.map(([request]) => request.requestId);
    expect(a).not.toBe(b);
  });

  it('links to Explore only for users who may use it', async () => {
    grafana.hasPermission.mockReturnValue(false);
    respond();
    const out = await run('query_prometheus', input);
    expect(grafana.hasPermission).toHaveBeenCalledWith('datasources:explore');
    expect(out.view?.explore).toBeUndefined();
  });
});

describe('time ranges', () => {
  const query = (start?: string, end?: string) =>
    run('query_prometheus', { datasourceUid: 'prometheus', expr: 'up', queryType: 'instant', start, end });
  const at = (iso: string) => Date.parse(iso);

  it.each([
    ['the last hour by default', undefined, undefined, NOW - HOUR, NOW],
    ['relative times', 'now-6h', 'now-1h', NOW - 6 * HOUR, NOW - HOUR],
    [
      'RFC3339 times',
      '2026-09-29T10:00:00Z',
      '2026-09-29T10:30:00Z',
      at('2026-09-29T10:00:00Z'),
      at('2026-09-29T10:30:00Z'),
    ],
    // models pass start = end for "right now"
    ['the hour before when start equals end', 'now', 'now', NOW - HOUR, NOW],
    [
      'the hour before an RFC3339 instant',
      '2026-09-29T10:00:00Z',
      '2026-09-29T10:00:00Z',
      at('2026-09-29T09:00:00Z'),
      at('2026-09-29T10:00:00Z'),
    ],
  ])('queries %s', async (_, start, end, from, to) => {
    respond();
    await query(start, end);
    expect(sentQuery()).toMatchObject({ from, to });
  });

  it.each([
    ['yesterday', 'now', 'Invalid time "yesterday" / "now". Use Grafana relative time (now-1h) or RFC3339 with Z.'],
    ['now', 'now-1h', 'start (now) must be before end (now-1h).'],
  ])('rejects start %p with end %p', async (start, end, message) => {
    await expect(query(start, end)).rejects.toThrow(message);
    expect(grafana.query).not.toHaveBeenCalled();
  });
});

describe('datasources', () => {
  it.each([
    ['an unknown uid', 'nope'],
    ['the uid of another type', 'loki'],
    ['a name instead of a uid', 'Prometheus'],
    ['no uid', undefined],
  ])('rejects %s and lists the available ones', async (_, uid) => {
    grafana.datasources.push(fakeDatasource({ uid: 'mimir', name: 'Mimir', type: 'prometheus' }));
    await expect(run('query_prometheus', { datasourceUid: uid, expr: 'up' })).rejects.toThrow(
      `No prometheus datasource with uid "${uid}". Available: Mimir (uid mimir), Prometheus (uid prometheus).`
    );
    expect(grafana.query).not.toHaveBeenCalled();
  });

  it('says when there is none of that type', async () => {
    grafana.datasources.length = 0;
    await expect(run('query_loki', { datasourceUid: 'loki', logql: '{app="x"}' })).rejects.toThrow(
      'No loki datasource with uid "loki". Available: none.'
    );
  });
});

describe('datasource queries', () => {
  const input = { datasourceUid: 'prometheus', expr: 'up', queryType: 'instant' };
  const failed = (response: Partial<DataQueryResponse>) => of({ data: [], state: LoadingState.Error, ...response });

  it.each([
    [
      'the error of a failed query',
      () => failed({ errors: [{ refId: 'A', message: 'parse error: unexpected }', status: 400 }] }),
      'parse error: unexpected }',
    ],
    [
      'a refused request',
      () => failed({ error: { message: 'Access denied to datasource', status: 403 } }),
      'Access denied to datasource',
    ],
    [
      'a failed request the datasource throws',
      () => throwError(() => ({ status: 502, data: { message: 'Bad Gateway' } })),
      'Bad Gateway',
    ],
    ['an Error the datasource throws', () => throwError(() => new Error('Unknown Datasource')), 'Unknown Datasource'],
    ['a rejected promise', () => Promise.reject(new TypeError('Failed to fetch')), 'Failed to fetch'],
    ['an error without a message', () => failed({ errors: [{ refId: 'A', status: 500 }] }), 'Query failed'],
    ['a thrown error without a message', () => throwError(() => ({ status: 500, data: {} })), 'Query failed'],
  ])('reports %s', async (_, response, message) => {
    grafana.query.mockImplementation(response);
    await expect(run('query_prometheus', input)).rejects.toThrow(message);
  });

  it('uses the final response of a query that sends partial ones first (Loki query splitting, Tempo streaming)', async () => {
    grafana.query.mockReturnValue(
      of(
        { data: [series({ job: 'a' }, [1])], state: LoadingState.Streaming },
        { data: [series({ job: 'a' }, [1]), series({ job: 'b' }, [2])], state: LoadingState.Done }
      )
    );
    expect((await run('query_prometheus', input)).view?.frames).toHaveLength(2);
  });

  it('takes a promise of the response', async () => {
    grafana.query.mockResolvedValue({ data: [series({ job: 'a' }, [1])] });
    expect((await run('query_prometheus', input)).forModel).toContain('{} 1');
  });

  it('stops the query when the run is stopped', async () => {
    const response = new Subject<DataQueryResponse>();
    const queried = new Promise<void>((resolve) =>
      grafana.query.mockImplementation(() => {
        resolve();
        return response;
      })
    );
    const stop = new AbortController();
    const out = executeTool('query_prometheus', input, stop.signal);
    await queried;
    expect(response.observed).toBe(true);
    stop.abort();
    await expect(out).rejects.toThrow('Stopped.');
    expect(response.observed).toBe(false);
  });
});

describe('list_prometheus_labels', () => {
  const values = (data?: string[]) => grafana.backend.get.mockResolvedValue({ status: 'success', data });
  const list = (input: Record<string, unknown>) =>
    run('list_prometheus_labels', { datasourceUid: 'prometheus', ...input });

  it('lists the label names of the matching series in whole seconds covering the range', async () => {
    values(['job', '__name__', 'instance']);
    const out = await list({ match: 'up', start: '2026-09-30T10:59:59.500Z', end: '2026-09-30T11:59:59.500Z' });
    expect(sentGet()).toEqual({
      url: '/api/datasources/uid/prometheus/resources/api/v1/labels',
      params: {
        'match[]': 'up',
        start: Date.parse('2026-09-30T10:59:59Z') / 1000,
        end: Date.parse('2026-09-30T12:00:00Z') / 1000,
      },
    });
    expect(out).toEqual({ forModel: 'Label names: 3 values: __name__, instance, job' });
  });

  it.each([
    ['_total$', 'http_requests_total, HTTP_errors_total'],
    ['^http_', 'http_requests_total'],
    // PromQL/RE2 style: (?i) makes the rest case-insensitive
    ['(?i)^http_', 'HTTP_errors_total, http_requests_total'],
  ])('lists the values of a label filtered by %p', async (regex, hits) => {
    values(['http_requests_total', 'HTTP_errors_total', 'up']);
    const out = await list({ label: '__name__', regex });
    expect(sentGet().url).toBe('/api/datasources/uid/prometheus/resources/api/v1/label/__name__/values');
    expect(out.forModel).toBe(
      `Values of __name__: ${hits.split(', ').length} values: ${hits.split(', ').sort().join(', ')}`
    );
  });

  it('rejects an invalid regex', async () => {
    values(['up']);
    await expect(list({ label: '__name__', regex: '(?i)[' })).rejects.toThrow('Invalid regex "(?i)["');
  });

  it('shows at most 200 values', async () => {
    values(Array.from({ length: 250 }, (_, i) => `v${String(i).padStart(3, '0')}`));
    const out = await list({ label: 'pod' });
    expect(out.forModel.startsWith('Values of pod: 250 values (showing 200): v000, v001,')).toBe(true);
    expect(out.forModel.endsWith(', v199')).toBe(true);
  });

  it('says when there are none', async () => {
    values(undefined);
    expect((await list({})).forModel).toBe('Label names: 0 values: (none)');
  });
});

describe('query_loki', () => {
  const input = { datasourceUid: 'loki', logql: '{service_name="api"} |= "error"', start: 'now-1h', end: 'now' };
  const query = { expr: '{service_name="api"} |= "error"', queryType: 'range', editorMode: 'code' };
  const logs = createDataFrame({
    refId: 'A',
    meta: { custom: { frameType: 'LabeledTimeValues' } },
    fields: [
      { name: 'labels', type: FieldType.other, values: [{ service_name: 'api' }, { service_name: 'api' }] },
      { name: 'Time', type: FieldType.time, values: [NOW - 1000, NOW - 2000] },
      { name: 'Line', type: FieldType.string, values: ['timeout calling db', 'connection refused'] },
    ],
  });

  it('fetches the newest log lines and shows them in a logs panel', async () => {
    respond(logs);
    const out = await run('query_loki', input);

    expect(sentQuery()).toEqual({
      from: NOW - HOUR,
      to: NOW,
      query: {
        refId: 'A',
        datasource: { type: 'loki', uid: 'loki' },
        maxLines: 50,
        direction: 'backward',
        step: '18s',
        ...query,
      },
    });
    expect(out.forModel).toBe(
      [
        RANGE,
        '2 lines, newest first. Common labels: {service_name="api"}',
        '2026-09-30T11:59:59.000Z timeout calling db',
        '2026-09-30T11:59:58.000Z connection refused',
      ].join('\n')
    );
    expect(out.view).toMatchObject({ panel: 'logs', height: 320 });
    expect(explorePane(out.view?.explore).queries).toEqual([
      { refId: 'A', datasource: { type: 'loki', uid: 'loki' }, ...query },
    ]);
  });

  it('recognizes dataplane log frames', async () => {
    respond(
      createDataFrame({
        meta: { type: 'log-lines' as any },
        fields: [
          { name: 'timestamp', type: FieldType.time, values: [NOW] },
          { name: 'body', type: FieldType.string, values: ['panic: nil map'] },
        ],
      })
    );
    const out = await run('query_loki', input);
    expect(out.forModel.endsWith('2026-09-30T12:00:00.000Z panic: nil map')).toBe(true);
    expect(out.view?.panel).toBe('logs');
  });

  it.each([
    [undefined, 50],
    [20, 20],
    ['20', 20],
    [2.6, 3],
    [0, 50],
    [-5, 1],
    [1000, 200],
  ])('clamps limit %p to %p lines', async (limit, maxLines) => {
    respond();
    await run('query_loki', { ...input, limit });
    expect(sentQuery().query.maxLines).toBe(maxLines);
  });

  it('tells the model when the limit cut the result', async () => {
    respond(logs);
    const out = await run('query_loki', { ...input, limit: 2 });
    expect(out.forModel).toContain('2 lines, newest first (limit reached, there are probably more; narrow the query).');
  });

  // ~200 points, at least 1s apart (without a step, Loki uses the request's interval, which can be finer)
  it.each([
    ['now-1m', '1s'],
    ['now-1h', '18s'],
    ['now-24h', '432s'],
    ['now-7d', '3024s'],
  ])('asks for about 200 points from %s', async (start, step) => {
    respond();
    await run('query_loki', { ...input, start });
    expect(sentQuery().query.step).toBe(step);
  });

  it('summarizes metric queries as series in a time series panel', async () => {
    respond(series({ service_name: 'api' }, [3, 5, 4]));
    const out = await run('query_loki', {
      ...input,
      logql: 'sum by (service_name) (count_over_time({service_name="api"}[5m]))',
    });
    expect(
      out.forModel.startsWith(
        `${RANGE}\n1 series (common labels: {service_name="api"}), sorted by max:\n{} n=3 min=3 max=5`
      )
    ).toBe(true);
    expect(out.view).toMatchObject({ panel: 'timeseries', height: 220 });
  });
});

describe('list_loki_labels', () => {
  it('lists the label names in the time range, in nanoseconds', async () => {
    grafana.backend.get.mockResolvedValue({ status: 'success', data: ['service_name', 'level'] });
    const out = await run('list_loki_labels', { datasourceUid: 'loki', start: 'now-1h', end: 'now' });
    expect(sentGet()).toEqual({
      url: '/api/datasources/uid/loki/resources/labels',
      params: { query: undefined, start: (NOW - HOUR) * 1e6, end: NOW * 1e6 },
    });
    expect(out).toEqual({ forModel: 'Label names: 2 values: level, service_name' });
  });

  it.each([
    ['{service_name=~"api|db"}', '{service_name=~"api|db"}'],
    // Loki rejects an empty selector ("at least one matcher")
    ['{}', undefined],
    ['{ }', undefined],
  ])('lists the values of a label for match %p', async (match, sent) => {
    grafana.backend.get.mockResolvedValue({ status: 'success', data: ['db', 'api'] });
    const out = await run('list_loki_labels', { datasourceUid: 'loki', label: 'service_name', match });
    const { url, params } = sentGet();
    expect(url).toBe('/api/datasources/uid/loki/resources/label/service_name/values');
    expect(params.query).toBe(sent);
    expect(out.forModel).toBe('Values of service_name: 2 values: api, db');
  });
});

describe('search_traces', () => {
  const input = { datasourceUid: 'tempo', traceql: '{ status = error }', start: 'now-1h', end: 'now' };
  const query = { queryType: 'traceql', query: '{ status = error }', limit: 20, spss: 3, tableType: 'traces' };
  // the shape Tempo's datasource returns: a trace id column whose link reloads the page, and the span sets in "nested"
  const traces = createDataFrame({
    name: 'Traces',
    refId: 'A',
    fields: [
      {
        name: 'traceID',
        type: FieldType.string,
        values: ['1f25ce22', '3894e679'],
        config: {
          links: [
            { title: 'Trace', url: '', internal: { query: {}, datasourceUid: 'tempo', datasourceName: 'Tempo' } },
          ],
        },
      },
      { name: 'startTime', type: FieldType.time, values: [NOW - 60_000, NOW - 30_000] },
      { name: 'traceService', type: FieldType.string, values: ['frontend', 'frontend'] },
      { name: 'traceName', type: FieldType.string, values: ['GET /dispatch', 'GET /config'] },
      { name: 'traceDuration', type: FieldType.number, values: [689, 1200] },
      { name: 'nested', type: FieldType.nestedFrames, values: [[], []] },
    ],
  });

  it('lists matching traces slowest first, in a table without the nested spans and page-reloading links', async () => {
    respond(traces);
    const out = await run('search_traces', input);

    expect(sentQuery().query).toEqual({ refId: 'A', datasource: { type: 'tempo', uid: 'tempo' }, ...query });
    expect(out.forModel).toBe(
      [
        RANGE,
        '2 traces, slowest first:',
        '3894e679 root=frontend "GET /config" start=2026-09-30T11:59:30.000Z duration=1200ms',
        '1f25ce22 root=frontend "GET /dispatch" start=2026-09-30T11:59:00.000Z duration=689ms',
      ].join('\n')
    );
    const [table] = out.view!.frames;
    expect(table.fields.map((f) => f.name)).toEqual([
      'traceID',
      'startTime',
      'traceService',
      'traceName',
      'traceDuration',
    ]);
    expect(table.fields.map((f) => f.config.links)).toEqual([[], [], [], [], []]);
    expect(out.view).toMatchObject({ panel: 'table', height: 80 + 2 * 36 });
    expect(explorePane(out.view?.explore).queries).toEqual([
      { refId: 'A', datasource: { type: 'tempo', uid: 'tempo' }, ...query },
    ]);
  });

  it('asks for at most 50 traces', async () => {
    respond();
    await run('search_traces', { ...input, limit: 500 });
    expect(sentQuery().query.limit).toBe(50);
  });

  it('shows TraceQL metrics queries as time series', async () => {
    respond(series({ 'resource.service.name': '"customer"' }, [0.5, 0.7]));
    const out = await run('search_traces', { ...input, traceql: '{} | rate() by (resource.service.name)' });
    expect(out.forModel.startsWith(`${RANGE}\n1 series (common labels: {resource.service.name=""customer""})`)).toBe(
      true
    );
    expect(out.view).toMatchObject({ panel: 'timeseries', height: 220 });
    expect(out.view?.explore).toBeDefined();
  });
});

describe('get_trace', () => {
  const trace = createDataFrame({
    name: 'Trace',
    refId: 'A',
    fields: [
      { name: 'spanID', type: FieldType.string, values: ['s1', 's2'] },
      { name: 'parentSpanID', type: FieldType.string, values: ['', 's1'] },
      { name: 'serviceName', type: FieldType.string, values: ['frontend', 'redis'] },
      { name: 'operationName', type: FieldType.string, values: ['GET /dispatch', 'GetDriver'] },
      { name: 'startTime', type: FieldType.number, values: [NOW - 5000, NOW - 4990] },
      { name: 'duration', type: FieldType.number, values: [700, 650] },
      { name: 'statusCode', type: FieldType.number, values: [0, 2] },
      { name: 'statusMessage', type: FieldType.string, values: ['', 'redis timeout'] },
    ],
  });

  it('looks the trace up by id and shows it in the trace view', async () => {
    respond(trace);
    const out = await run('get_trace', { datasourceUid: 'tempo', traceId: ' 3894E67985526E5D9F1C260E923427B1 ' });

    // a TraceQL query of only hex digits is a trace lookup, in no time window unless the datasource time-shifts it
    expect(sentQuery()).toEqual({
      from: NOW - HOUR,
      to: NOW,
      query: {
        refId: 'A',
        datasource: { type: 'tempo', uid: 'tempo' },
        queryType: 'traceql',
        query: '3894E67985526E5D9F1C260E923427B1',
      },
    });
    expect(out.forModel.startsWith('2 spans. Root: frontend "GET /dispatch" 700ms')).toBe(true);
    expect(out.forModel.endsWith('Error spans: redis "GetDriver": redis timeout')).toBe(true);
    expect(out.view).toMatchObject({ panel: 'traces', height: 460 });
    expect(explorePane(out.view?.explore)).toEqual({
      datasource: 'tempo',
      queries: [
        {
          refId: 'A',
          datasource: { type: 'tempo', uid: 'tempo' },
          queryType: 'traceql',
          query: '3894E67985526E5D9F1C260E923427B1',
        },
      ],
      range: { from: String(NOW - HOUR), to: String(NOW) },
    });
  });

  it('says when the trace does not exist', async () => {
    // what Tempo's datasource returns then
    respond(createDataFrame({ fields: [{ name: 'trace', type: FieldType.trace, values: [] }] }));
    expect(await run('get_trace', { datasourceUid: 'tempo', traceId: 'abc' })).toEqual({
      forModel: 'Trace not found (it may be outside the retention period or the id is wrong).',
      view: undefined,
    });
  });

  it.each(['trace-1', 'a'.repeat(33), ''])('rejects the trace id %p', async (traceId) => {
    await expect(run('get_trace', { datasourceUid: 'tempo', traceId })).rejects.toThrow(
      `"${traceId}" is not a hex trace id.`
    );
    expect(grafana.query).not.toHaveBeenCalled();
  });
});

describe('get_alerts', () => {
  const GRAFANA = '/api/prometheus/grafana/api/v1/rules';
  const PROMETHEUS = '/api/prometheus/prometheus/api/v1/rules';

  /** Answers GET requests by URL. Anything else fails, like a datasource without a ruler. */
  const routes = (map: Record<string, (params: any) => unknown>) =>
    grafana.backend.get.mockImplementation(async (url: string, params?: any) =>
      map[url] ? map[url](params) : grafana.notFaked(url)
    );
  const groups = (name: string, file: string, rules: object[]) => ({
    status: 'success',
    data: { groups: [{ name, file, rules }] },
  });
  const calls = () => grafana.backend.get.mock.calls.map(([url, params]) => [url, params]);

  // Grafana-managed rules, as Grafana 12 returns them
  const payments = {
    uid: 'payments-down',
    name: 'Payments service down',
    state: 'firing',
    health: 'ok',
    type: 'alerting',
    duration: 60,
    query: 'up{job="payments"}',
    queriedDatasourceUIDs: ['prometheus'],
    labels: { severity: 'critical' },
    annotations: {
      summary: 'The payments scrape target is not reachable',
      runbook_url: 'https://runbooks.example/payments',
    },
    activeAt: '2026-09-30T11:23:00Z',
    alerts: [
      {
        labels: { alertname: 'Payments service down', job: 'payments' },
        state: 'Alerting',
        activeAt: '2026-09-30T11:23:00Z',
        value: '1e+00',
      },
    ],
    totals: { alerting: 1 },
    totalsFiltered: { alerting: 1 },
  };
  // firing, and its last evaluation failed: both Grafana requests return it
  const spanErrors = {
    ...payments,
    uid: 'span-errors',
    name: 'Service returning errors',
    health: 'error',
    lastError: 'context deadline exceeded',
    labels: {},
    annotations: { summary: 'A service has server spans with error status' },
    activeAt: '2026-09-30T11:40:00Z',
  };
  const diskNoData = {
    uid: 'disk-full',
    name: 'Disk almost full',
    state: 'inactive',
    health: 'nodata',
    type: 'alerting',
    duration: 300,
    query: 'node_filesystem_avail_bytes',
    queriedDatasourceUIDs: ['prometheus'],
    alerts: [],
    totals: {},
    totalsFiltered: {},
  };
  // rules evaluated by the Prometheus ruler: no uid or activeAt of their own, instance values are query results
  const rulerRules = [
    {
      name: 'HotRODRedisErrors',
      state: 'firing',
      health: 'ok',
      type: 'alerting',
      query: 'sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m])) > 0',
      labels: { severity: 'warning' },
      annotations: { summary: 'redis-manual spans are failing' },
      alerts: [
        {
          labels: { alertname: 'HotRODRedisErrors', service: 'redis-manual' },
          state: 'firing',
          activeAt: '2026-09-30T11:30:12.337205355Z',
          value: '2.0130982014611027e+00',
        },
      ],
    },
    { name: 'HotRODSlow', state: 'inactive', health: 'ok', type: 'alerting', alerts: [] },
    {
      name: 'HotRODBroken',
      state: 'inactive',
      health: 'err',
      lastError: 'bad_data: parse error',
      type: 'alerting',
      alerts: [],
    },
    { name: 'job:up:sum', health: 'ok', type: 'recording' },
  ];

  it('merges Grafana and ruler rules, earliest first, with the rules that fail to evaluate', async () => {
    routes({
      [GRAFANA]: (p) => groups('services', 'Demo', p.health ? [diskNoData, spanErrors] : [payments, spanErrors]),
      [PROMETHEUS]: () => groups('hotrod', '/etc/prometheus/rules.yml', rulerRules),
      // Loki is not faked: its ruler request fails and is skipped
    });
    const out = await run('get_alerts', {});

    const sent = calls();
    expect(sent).toHaveLength(4); // not Tempo: it has no ruler
    expect(sent).toContainEqual([
      GRAFANA,
      {
        rule_type: 'alerting',
        state: ['firing', 'pending'],
        limit_alerts: 10,
        rule_uid: undefined,
        'search.rule_name': undefined,
      },
    ]);
    expect(sent).toContainEqual([
      GRAFANA,
      { rule_type: 'alerting', health: ['error', 'nodata'], limit_alerts: 3, 'search.rule_name': undefined },
    ]);
    expect(sent).toContainEqual([PROMETHEUS, { type: 'alert' }]);
    expect(sent).toContainEqual(['/api/prometheus/loki/api/v1/rules', { type: 'alert' }]);
    for (const call of grafana.backend.get.mock.calls) {
      expect(call[3]).toEqual({ showErrorAlert: false, abortSignal: signal });
    }

    const lines = out.forModel.split('\n');
    expect(lines[0]).toBe(
      '5 alert rules (states ["firing","pending"] plus rules with health error/nodata; Grafana-managed and from ' +
        'Prometheus/Mimir/Loki rulers), earliest first:'
    );
    const ruler = 'source=Prometheus ruler uid=prometheus//etc/prometheus/rules.yml/hotrod';
    expect(lines.filter((l) => l.startsWith('- '))).toEqual([
      '- FIRING since 2026-09-30T11:23:00Z "Payments service down" source=Grafana uid=payments-down folder="Demo" group="services" for=60s health=ok',
      `- FIRING since 2026-09-30T11:30:12.337205355Z "HotRODRedisErrors" ${ruler}/HotRODRedisErrors folder="/etc/prometheus/rules.yml" group="hotrod" for=0s health=ok`,
      '- FIRING since 2026-09-30T11:40:00Z "Service returning errors" source=Grafana uid=span-errors folder="Demo" group="services" for=60s health=error lastError="context deadline exceeded"',
      '- INACTIVE "Disk almost full" source=Grafana uid=disk-full folder="Demo" group="services" for=300s health=nodata',
      `- INACTIVE "HotRODBroken" ${ruler}/HotRODBroken folder="/etc/prometheus/rules.yml" group="hotrod" for=0s health=err lastError="bad_data: parse error"`,
    ]);
    expect(out.forModel).toContain(
      [
        '  labels: {"severity":"critical"}',
        '  summary: The payments scrape target is not reachable',
        '  runbook_url: https://runbooks.example/payments',
        '  query [prometheus]: up{job="payments"}',
        '  instances ({"alerting":1}):',
        '    {alertname=Payments service down, job=payments} Alerting condition=1e+00 since 2026-09-30T11:23:00Z',
      ].join('\n')
    );
    // a ruler instance's value is the query result
    expect(out.forModel).toContain(
      '  instances (1):\n    {alertname=HotRODRedisErrors, service=redis-manual} firing value=2.0130982014611027e+00 since 2026-09-30T11:30:12.337205355Z'
    );
    expect(out.forModel).toContain('  no active instances');

    expect(out.view).toMatchObject({ panel: 'table', height: 80 + 5 * 36 });
    expect(column(out, 'State')).toEqual(['firing', 'firing', 'firing', 'inactive', 'inactive']);
    expect(column(out, 'Source')).toEqual(['Grafana', 'Prometheus ruler', 'Grafana', 'Grafana', 'Prometheus ruler']);
    expect(column(out, 'Since')).toEqual([
      Date.parse('2026-09-30T11:23:00Z'),
      Date.parse('2026-09-30T11:30:12.337Z'),
      Date.parse('2026-09-30T11:40:00Z'),
      null,
      null,
    ]);
    expect(column(out, 'Health')).toEqual(['ok', 'ok', 'error', 'nodata', 'err']);
    expect(column(out, 'Summary')).toEqual([
      'The payments scrape target is not reachable',
      'redis-manual spans are failing',
      'A service has server spans with error status',
      '',
      '',
    ]);
  });

  it('asks for the given states', async () => {
    routes({
      [GRAFANA]: () => groups('services', 'Demo', []),
      [PROMETHEUS]: () => groups('hotrod', 'rules.yml', rulerRules),
    });
    const out = await run('get_alerts', { states: ['inactive'] });
    expect(calls()).toContainEqual([GRAFANA, expect.objectContaining({ state: ['inactive'] })]);
    expect(out.forModel.startsWith('2 alert rules (states ["inactive"] plus rules with health error/nodata;')).toBe(
      true
    );
    expect(column(out, 'Rule')).toEqual(['HotRODSlow', 'HotRODBroken']);
  });

  it('only returns rules whose title has the search words, also among the rules that fail to evaluate', async () => {
    routes({
      [GRAFANA]: () => groups('services', 'Demo', []),
      [PROMETHEUS]: () => groups('hotrod', 'rules.yml', rulerRules),
    });
    const out = await run('get_alerts', { search: 'Redis errors db' });
    const searched = calls()
      .filter(([url]) => url === GRAFANA)
      .map(([, params]) => params['search.rule_name']);
    expect(searched).toEqual(['Redis errors db', 'Redis errors db']);
    // ruler rules are filtered here, ignoring words shorter than 3 characters
    expect(column(out, 'Rule')).toEqual(['HotRODRedisErrors']);
  });

  it('skips datasources whose alerting is turned off', async () => {
    grafana.datasources.push(
      fakeDatasource({ uid: 'mimir', name: 'Mimir', type: 'prometheus', jsonData: { manageAlerts: false } })
    );
    routes({ [GRAFANA]: () => groups('services', 'Demo', []) });
    await run('get_alerts', {});
    expect(calls().map(([url]) => url)).not.toContain('/api/prometheus/mimir/api/v1/rules');
  });

  it('fetches one rule with its full definition', async () => {
    routes({
      [GRAFANA]: () => groups('services', 'Demo', [payments]),
      '/api/ruler/grafana/api/v1/rule/payments-down': () => ({
        for: '1m',
        grafana_alert: {
          uid: 'payments-down',
          condition: 'C',
          no_data_state: 'NoData',
          exec_err_state: 'Alerting',
          data: [
            {
              refId: 'A',
              relativeTimeRange: { from: 300, to: 0 },
              datasourceUid: 'prometheus',
              model: { expr: 'up{job="payments"}', instant: true, refId: 'A' },
            },
            {
              refId: 'C',
              relativeTimeRange: { from: 0, to: 0 },
              datasourceUid: '__expr__',
              model: { type: 'threshold', expression: 'A', conditions: [{ evaluator: { params: [1], type: 'lt' } }] },
            },
          ],
        },
      }),
    });
    const out = await run('get_alerts', { ruleUid: 'payments-down' });

    // no broken-rules or ruler requests for a single rule
    expect(calls()).toEqual([
      [
        GRAFANA,
        {
          rule_type: 'alerting',
          state: undefined,
          rule_uid: 'payments-down',
          'search.rule_name': undefined,
          limit_alerts: 10,
        },
      ],
      ['/api/ruler/grafana/api/v1/rule/payments-down', undefined],
    ]);
    expect(
      out.forModel.startsWith('Alert rule payments-down:\n- FIRING since 2026-09-30T11:23:00Z "Payments service down"')
    ).toBe(true);
    expect(
      out.forModel.endsWith(
        [
          'Definition: condition=C for=1m noData=NoData execErr=Alerting',
          '  A [prometheus] last 300s: up{job="payments"}',
          '  C [__expr__] last 0s: {"type":"threshold","expression":"A","conditions":[{"evaluator":{"params":[1],"type":"lt"}}]}',
        ].join('\n')
      )
    ).toBe(true);
  });

  it('still lists the rule when its definition cannot be read', async () => {
    routes({ [GRAFANA]: () => groups('services', 'Demo', [payments]) });
    const out = await run('get_alerts', { ruleUid: 'payments-down' });
    expect(out.forModel).toContain('"Payments service down"');
    expect(out.forModel).not.toContain('Definition:');
  });

  it('counts instances past the limit_alerts cap, and failed evaluations once', async () => {
    const rule = (uid: string, totalsFiltered: Record<string, number> | undefined, alerts: number) => ({
      uid,
      name: uid,
      state: 'firing',
      health: 'ok',
      totalsFiltered,
      alerts: Array.from({ length: alerts }, () => ({ labels: {}, state: 'Alerting' })),
    });
    routes({
      [GRAFANA]: (p) =>
        groups(
          'services',
          'Demo',
          p.health
            ? []
            : [
                rule('capped', { alerting: 12, pending: 1 }, 10),
                // an instance whose evaluation failed counts as its state and as "error"
                rule('errored', { alerting: 2, error: 2 }, 2),
                rule('only-errors', { error: 5 }, 3),
                rule('no-totals', undefined, 2),
                rule('none', {}, 0),
              ]
        ),
    });
    const out = await run('get_alerts', {});
    expect(column(out, 'Instances')).toEqual([13, 2, 5, 2, 0]);
  });

  it('gives the model the first 25 rules and the table all of them', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...payments,
      uid: `r${i}`,
      name: `Rule ${i}`,
      activeAt: `2026-09-30T11:${10 + i}:00Z`,
    }));
    routes({ [GRAFANA]: (p) => groups('services', 'Demo', p.health ? [] : [...many].reverse()) });
    const out = await run('get_alerts', {});
    expect(out.forModel.split('\n')[0].endsWith('earliest first, showing 25:')).toBe(true);
    expect(out.forModel).toContain('"Rule 24"');
    expect(out.forModel).not.toContain('"Rule 25"');
    expect(column(out, 'Rule')).toEqual(many.map((r) => r.name));
    expect(out.view?.height).toBe(320);
  });

  it('says so when no rule matches', async () => {
    routes({ [GRAFANA]: () => ({ status: 'success', data: { groups: [] } }) });
    expect(await run('get_alerts', {})).toEqual({ forModel: 'No matching alert rules.', view: undefined });
  });

  it("fails when Grafana's own rules cannot be read", async () => {
    grafana.backend.get.mockRejectedValue({ status: 403, data: { message: 'Access denied' } });
    await expect(run('get_alerts', {})).rejects.toEqual({ status: 403, data: { message: 'Access denied' } });
  });
});

describe('describeCall', () => {
  it.each([
    ['get_alerts', {}, { title: 'Firing alerts' }],
    ['get_alerts', { ruleUid: 'payments-down' }, { title: 'Alert rule payments-down' }],
    ['query_prometheus', { datasourceUid: 'prometheus', expr: 'up' }, { title: 'PromQL · Prometheus', code: 'up' }],
    ['query_prometheus', { datasourceUid: 'deleted', expr: 'up' }, { title: 'PromQL', code: 'up' }],
    [
      'list_prometheus_labels',
      { datasourceUid: 'prometheus', label: 'job', match: 'up' },
      { title: 'Values of job · Prometheus', code: 'up' },
    ],
    ['query_loki', { datasourceUid: 'loki', logql: '{app="x"}' }, { title: 'LogQL · Loki', code: '{app="x"}' }],
    ['list_loki_labels', { datasourceUid: 'loki' }, { title: 'Label names · Loki', code: undefined }],
    ['search_traces', { datasourceUid: 'tempo', traceql: '{}' }, { title: 'TraceQL · Tempo', code: '{}' }],
    ['get_trace', { datasourceUid: 'tempo', traceId: 'abc' }, { title: 'Trace · Tempo', code: 'abc' }],
    ['some_new_tool', {}, { title: 'some_new_tool' }],
  ])('%s %j', (name, input, expected) => {
    expect(describeCall(name, input)).toEqual(expected);
  });
});
