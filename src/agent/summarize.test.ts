import { FieldType, createDataFrame } from '@grafana/data';
import { summarizeInstant, summarizeLogs, summarizeSeries, summarizeTrace, summarizeTraceSearch } from './summarize';

const series = (labels: Record<string, string>, values: Array<number | null>) =>
  createDataFrame({
    fields: [
      { name: 'Time', type: FieldType.time, values: values.map((_, i) => 1_700_000_000_000 + i * 15_000) },
      { name: 'Value', type: FieldType.number, values, labels },
    ],
  });

const logs = (fields: { labels: object[]; timestamp: number[]; body: string[] }) =>
  createDataFrame({
    fields: [
      { name: 'labels', type: FieldType.other, values: fields.labels },
      { name: 'timestamp', type: FieldType.time, values: fields.timestamp },
      { name: 'body', type: FieldType.string, values: fields.body },
    ],
  });

const spans = (rows: Array<[id: string, parent: string, service: string, op: string, duration: number]>) =>
  createDataFrame({
    fields: [
      { name: 'spanID', type: FieldType.string, values: rows.map((r) => r[0]) },
      { name: 'parentSpanID', type: FieldType.string, values: rows.map((r) => r[1]) },
      { name: 'serviceName', type: FieldType.string, values: rows.map((r) => r[2]) },
      { name: 'operationName', type: FieldType.string, values: rows.map((r) => r[3]) },
      { name: 'startTime', type: FieldType.number, values: rows.map(() => 0) },
      { name: 'duration', type: FieldType.number, values: rows.map((r) => r[4]) },
    ],
  });

describe('summarize', () => {
  it('flags empty results as "probably a wrong name", not healthy', () => {
    expect(summarizeSeries([])).toMatch(/^No series returned\. An empty result usually means a wrong/);
    expect(summarizeInstant([])).toMatch(/^No series returned\. An empty result usually means a wrong/);
    expect(summarizeLogs([], 100)).toMatch(/^No log lines\. .*not proof that there are no errors/);
    expect(summarizeTraceSearch([])).toMatch(/^No traces matched\./);
    expect(summarizeTraceSearch([createDataFrame({ fields: [] })])).toMatch(/^No traces matched\./);
    expect(summarizeTrace([])).toMatch(/^Trace not found/);
    expect(summarizeTrace([createDataFrame({ fields: [] })])).toMatch(/^Trace not found/);
  });

  it('skips null and NaN samples and sorts series without any value last', () => {
    const out = summarizeSeries([series({ job: 'none' }, [null, NaN]), series({ job: 'gaps' }, [1, null, NaN, 3])]);
    expect(out.split('\n').slice(1)).toEqual([
      '{job="gaps"} n=4 min=1 max=3@2023-11-14T22:14:05.000Z avg=2 last=3 shape=[1 _ _ 3]',
      '{job="none"} n=2 min=NaN max=NaN@? avg=NaN last=NaN shape=[_ _]',
    ]);
  });

  it('keeps the flat-lined series, even past the row and size limits', () => {
    // 40 series with long labels (well over the text budget), 3 of them at 0: sorted by max they come last
    const frames = Array.from({ length: 40 }, (_, i) =>
      series({ job: 'node', instance: `host-${i}-${'x'.repeat(300)}` }, [7, 19, 33].includes(i) ? [0, 0] : [1, 1])
    );
    const out = summarizeSeries(frames);
    expect(out).toContain('…(truncated)\n…20 more series omitted. Of those, the lowest min:');
    for (const i of [7, 19, 33]) {
      expect(out).toMatch(new RegExp(`host-${i}-x+"\\} n=2 min=0 `));
    }
  });

  it('hoists common labels, sorts by max and caps the series count', () => {
    const frames = [
      series({ job: 'api', pod: 'a' }, [1, 2, 3]),
      series({ job: 'api', pod: 'b' }, [5, 9, 1]),
      series({ job: 'api', pod: 'c' }, [0, 0, 0]),
    ];
    const out = summarizeSeries(frames, 2).split('\n');
    expect(out[0]).toBe('3 series (common labels: {job="api"}), sorted by max:');
    expect(out[1]).toMatch(/^\{pod="b"\} n=3 min=1 max=9@\S+ avg=5 last=1/);
    // the cut keeps the flat-lined pod, not the next-highest one
    expect(out[2]).toBe('…1 more series omitted. Of those, the lowest min:');
    expect(out[3]).toMatch(/^\{pod="c"\}/);
  });

  it('keeps the targets that are down, even past the row and size limits', () => {
    // 40 targets with long labels (well over the text budget), 3 of them down: sorted high to low they come last
    const frames = Array.from({ length: 40 }, (_, i) =>
      series({ job: 'node', instance: `host-${i}-${'x'.repeat(250)}` }, [[7, 19, 33].includes(i) ? 0 : 1])
    );
    const out = summarizeInstant(frames);
    expect(out).toContain('values: 1 ×37, 0 ×3');
    expect(out).toContain('…(truncated)');
    for (const i of [7, 19, 33]) {
      expect(out).toMatch(new RegExp(`host-${i}-x+"\\} 0`));
    }
  });

  it('reports instant values largest first', () => {
    const out = summarizeInstant([series({ job: 'x' }, [0]), series({ job: 'y' }, [1])]);
    expect(out.split('\n').slice(1)).toEqual(['{job="y"} 1', '{job="x"} 0']);
  });

  it('collapses repeated log lines that only differ in numbers', () => {
    const frame = createDataFrame({
      fields: [
        { name: 'labels', type: FieldType.other, values: [{ app: 'a' }, { app: 'a' }, { app: 'a' }] },
        { name: 'Time', type: FieldType.time, values: [3, 2, 1] },
        { name: 'Line', type: FieldType.string, values: ['timeout after 31ms', 'timeout after 45ms', 'ok'] },
      ],
    });
    const out = summarizeLogs([frame], 100).split('\n');
    expect(out[0]).toBe('3 lines, newest first. Common labels: {app="a"}');
    expect(out[2]).toBe('  (previous line repeated 1x with different numbers/ids)');
    expect(out[3]).toMatch(/ ok$/);
  });

  it('reads the dataplane log frame (timestamp/body) and shows labels that differ per line', () => {
    const frame = logs({
      labels: [
        { app: 'a', level: 'error' },
        { app: 'a', level: 'info' },
      ],
      timestamp: [1_700_000_001_000, 1_700_000_000_000],
      body: ['payment failed', 'started'],
    });
    expect(summarizeLogs([frame], 100).split('\n')).toEqual([
      '2 lines, newest first. Common labels: {app="a"}',
      '2023-11-14T22:13:21.000Z {level="error"} payment failed',
      '2023-11-14T22:13:20.000Z {level="info"} started',
    ]);
  });

  it('collapses a repeat at the end of the list and says when the limit was reached', () => {
    const frame = logs({
      labels: [{}, {}, {}, {}],
      timestamp: [4, 3, 2, 1],
      body: ['ok', 'request 0x1f2e3d4c5b failed', 'request 0xaabbccddee failed', 'request 0x0123456789 failed'],
    });
    const out = summarizeLogs([frame], 4).split('\n');
    expect(out[0]).toBe(
      '4 lines, newest first (limit reached, there are probably more; narrow the query). Common labels: {}'
    );
    expect(out.slice(2)).toEqual([
      '1970-01-01T00:00:00.003Z request 0x1f2e3d4c5b failed',
      '  (previous line repeated 2x with different numbers/ids)',
    ]);
  });

  it('lists found traces slowest first', () => {
    const frame = createDataFrame({
      name: 'Traces',
      fields: [
        { name: 'traceID', type: FieldType.string, values: ['fast', 'slow', 'unknown'] },
        { name: 'startTime', type: FieldType.time, values: [0, 1000, 2000] },
        { name: 'traceService', type: FieldType.string, values: ['api', 'checkout', 'cron'] },
        { name: 'traceName', type: FieldType.string, values: ['GET /', 'POST /pay', 'tick'] },
        { name: 'traceDuration', type: FieldType.number, values: [12, 2345, null] },
      ],
    });
    expect(summarizeTraceSearch([frame]).split('\n')).toEqual([
      '3 traces, slowest first:',
      'slow root=checkout "POST /pay" start=1970-01-01T00:00:01.000Z duration=2345ms',
      'fast root=api "GET /" start=1970-01-01T00:00:00.000Z duration=12ms',
      'unknown root=cron "tick" start=1970-01-01T00:00:02.000Z duration=0ms',
    ]);
  });

  it('keeps a duration Tempo reports as text', () => {
    const frame = createDataFrame({
      name: 'Traces',
      fields: [
        { name: 'traceID', type: FieldType.string, values: ['tiny', 'slow'] },
        { name: 'traceDuration', type: FieldType.other, values: ['<1ms', 5] },
      ],
    });
    expect(summarizeTraceSearch([frame])).toMatch(/slow .* duration=5ms\ntiny .* duration=<1ms$/);
  });

  it('takes the span whose parent is not in the trace as the root', () => {
    // a trace fragment: the root's parent lives in another system, and the root is not the first row
    const frame = spans([
      ['db', 'root', 'mysql', 'SELECT', 30],
      ['root', 'upstream', 'api', 'GET /', 100],
    ]);
    expect(summarizeTrace([frame]).split('\n').slice(0, 2)).toEqual([
      '2 spans. Root: api "GET /" 100ms starting 1970-01-01T00:00:00.000Z',
      'Services: mysql (1 spans); api (1 spans)',
    ]);
    expect(summarizeTrace([frame])).toContain('No error spans.');
  });

  it('finds the span with the most self time, not the longest parent', () => {
    const frame = createDataFrame({
      fields: [
        { name: 'spanID', type: FieldType.string, values: ['root', 'db'] },
        { name: 'parentSpanID', type: FieldType.string, values: ['', 'root'] },
        { name: 'serviceName', type: FieldType.string, values: ['api', 'mysql'] },
        { name: 'operationName', type: FieldType.string, values: ['GET /', 'SELECT'] },
        { name: 'startTime', type: FieldType.number, values: [0, 1] },
        { name: 'duration', type: FieldType.number, values: [100, 90] },
        { name: 'statusCode', type: FieldType.number, values: [0, 2] },
        { name: 'statusMessage', type: FieldType.string, values: ['', 'deadlock'] },
      ],
    });
    const out = summarizeTrace([frame]);
    expect(out).toContain('Most self time: mysql "SELECT" self=90ms');
    expect(out).toContain('Error spans: mysql "SELECT": deadlock');
  });
});
