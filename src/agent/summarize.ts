import { DataFrame, Field, FieldType, Labels } from '@grafana/data';

// Turns query results into compact text for the model. The full frames stay in the browser for the panels;
// sending raw samples would cost 100K+ tokens per query.

const MAX_CHARS = 6000;
const sig = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? String(Number(v.toPrecision(4))) : String(v);
const iso = (ms: unknown) => (typeof ms === 'number' ? new Date(ms).toISOString() : '?');
/** `tail` always survives the cut: it holds the lowest series, which are often the broken ones. */
const cap = (lines: string[], max = MAX_CHARS, tail: string[] = []) => {
  const out = lines.join('\n');
  const room = Math.max(0, max - tail.join('\n').length);
  return [out.length > room ? out.slice(0, room) + '\n…(truncated)' : out, ...tail].join('\n');
};
// Of `top` rows, a quarter goes to the low end: sorted high to low, a target at 0 or a series that dropped out
// would otherwise be the first thing cut, and the model would call everything healthy.
const lowShare = (rows: number, top: number) => (rows > top ? Math.ceil(top / 4) : 0);
const fmtLabels = (l: Labels) =>
  Object.entries(l)
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');

const commonLabels = (all: Labels[]): Labels => {
  const [first = {}, ...rest] = all;
  return Object.fromEntries(Object.entries(first).filter(([k, v]) => rest.every((l) => l[k] === v)));
};
const without = (l: Labels, common: Labels) => Object.fromEntries(Object.entries(l).filter(([k]) => !(k in common)));

interface Series {
  labels: Labels;
  times: number[];
  values: Array<number | null>;
}

/** Every number field of the frames as one series, with the frame's time field. */
const toSeries = (frames: DataFrame[]): Series[] =>
  frames.flatMap((f) => {
    const time = f.fields.find((x) => x.type === FieldType.time);
    return f.fields
      .filter((x) => x.type === FieldType.number)
      .map((v) => ({
        labels: v.labels ?? {},
        times: (time?.values ?? []) as number[],
        values: v.values as Array<number | null>,
      }));
  });

/** Range results: per series min/max/avg/last, time of max and a 12-point shape; top N by max. */
export const summarizeSeries = (frames: DataFrame[], top = 20, points = 12): string => {
  const series = toSeries(frames);
  if (!series.length) {
    return 'No series returned. An empty result usually means a wrong metric, label or value (or no data in this time range), not that everything is healthy. Check names with the list_* tools.';
  }
  const common = commonLabels(series.map((s) => s.labels));
  const rows = series.map(({ labels, times, values }) => {
    const nums = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    const max = nums.length ? Math.max(...nums) : NaN;
    const min = nums.length ? Math.min(...nums) : NaN;
    const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN;
    const last = [...values].reverse().find((x) => typeof x === 'number');
    const step = Math.max(1, Math.ceil(values.length / points));
    const shape: string[] = [];
    for (let i = 0; i < values.length; i += step) {
      const w = values.slice(i, i + step).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
      shape.push(w.length ? sig(w.reduce((a, b) => a + b, 0) / w.length) : '_');
    }
    const line =
      `{${fmtLabels(without(labels, common))}} n=${values.length} min=${sig(min)} max=${sig(max)}` +
      `@${iso(times[values.indexOf(max)])} avg=${sig(avg)} last=${sig(last)} shape=[${shape.join(' ')}]`;
    return { max: Number.isNaN(max) ? -Infinity : max, min: Number.isNaN(min) ? Infinity : min, line };
  });
  rows.sort((a, b) => b.max - a.max);
  const low = lowShare(rows.length, top);
  // by min, not max: a series that dipped to 0 for a while still has a normal max
  const lowest = rows
    .slice(top - low)
    .sort((a, b) => a.min - b.min)
    .slice(0, low);
  return cap(
    [
      `${series.length} series (common labels: {${fmtLabels(common)}}), sorted by max:`,
      ...rows.slice(0, top - low).map((r) => r.line),
    ],
    MAX_CHARS,
    low ? [`…${rows.length - top} more series omitted. Of those, the lowest min:`, ...lowest.map((r) => r.line)] : []
  );
};

/** Instant results: one value per series, largest first, plus the smallest when there are too many to list. */
export const summarizeInstant = (frames: DataFrame[], top = 30): string => {
  const series = toSeries(frames);
  if (!series.length) {
    return 'No series returned. An empty result usually means a wrong metric, label or value, not that everything is healthy.';
  }
  const common = commonLabels(series.map((s) => s.labels));
  const rows = series
    .map((s) => ({ labels: without(s.labels, common), v: s.values[s.values.length - 1] }))
    .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
  const line = (r: (typeof rows)[number]) => `{${fmtLabels(r.labels)}} ${sig(r.v)}`;
  const low = lowShare(rows.length, top);
  // few distinct values (up, health flags): the counts answer "is everything up?" even for series not listed
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(sig(r.v), (counts.get(sig(r.v)) ?? 0) + 1));
  const spread = low && counts.size <= 10 ? [`values: ${[...counts].map(([v, n]) => `${v} ×${n}`).join(', ')}`] : [];
  return cap(
    [
      `${series.length} series (common labels: {${fmtLabels(common)}}):`,
      ...spread,
      ...rows.slice(0, top - low).map(line),
    ],
    MAX_CHARS,
    low ? [`…${rows.length - top} more omitted. The lowest:`, ...rows.slice(-low).map(line)] : []
  );
};

/** Loki log frames, both the legacy (labels/Time/Line) and the dataplane (labels/timestamp/body) shape. */
export const summarizeLogs = (frames: DataFrame[], requested: number): string => {
  const lines: Array<{ t: number; labels: Labels; line: string }> = [];
  for (const f of frames) {
    const time = f.fields.find((x) => x.type === FieldType.time);
    const body = f.fields.find((x) => x.name === 'Line' || x.name === 'body'); // legacy / dataplane frame
    const labels = f.fields.find((x) => x.name === 'labels');
    for (let i = 0; i < (body?.values.length ?? 0); i++) {
      lines.push({ t: time?.values[i], labels: (labels?.values[i] as Labels) ?? {}, line: String(body!.values[i]) });
    }
  }
  if (!lines.length) {
    return 'No log lines. Check the stream selector labels with list_loki_labels; an empty result is not proof that there are no errors.';
  }
  const common = commonLabels(lines.map((l) => l.labels));
  // collapse consecutive lines that only differ in numbers / hex ids
  const mask = (s: string) => s.replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, '0');
  const out: string[] = [];
  let prev = '';
  let repeat = 0;
  for (const l of lines) {
    const key = mask(l.line) + fmtLabels(without(l.labels, common));
    if (key === prev) {
      repeat++;
      continue;
    }
    if (repeat) {
      out.push(`  (previous line repeated ${repeat}x with different numbers/ids)`);
    }
    repeat = 0;
    prev = key;
    const own = fmtLabels(without(l.labels, common));
    out.push(`${iso(l.t)} ${own ? `{${own}} ` : ''}${l.line.length > 300 ? l.line.slice(0, 300) + '…' : l.line}`);
  }
  if (repeat) {
    out.push(`  (previous line repeated ${repeat}x with different numbers/ids)`);
  }
  const more = lines.length >= requested ? ' (limit reached, there are probably more; narrow the query)' : '';
  return cap([`${lines.length} lines, newest first${more}. Common labels: {${fmtLabels(common)}}`, ...out], 8000);
};

const col = (f: DataFrame, name: string): Field | undefined => f.fields.find((x) => x.name === name);

/** Tempo search ("Traces" frame): slowest first. */
export const summarizeTraceSearch = (frames: DataFrame[]): string => {
  const f = frames[0];
  const n = f?.length ?? 0;
  if (!f || !n) {
    return 'No traces matched. Check attribute names/values (e.g. resource.service.name) and the time range.';
  }
  const rows = Array.from({ length: n }, (_, i) => {
    // milliseconds, or a text such as "<1ms" (Tempo's streaming search)
    const duration = col(f, 'traceDuration')?.values[i] as number | string | null;
    return {
      id: col(f, 'traceID')?.values[i],
      start: col(f, 'startTime')?.values[i],
      service: col(f, 'traceService')?.values[i],
      name: col(f, 'traceName')?.values[i],
      ms: typeof duration === 'number' ? duration : 0,
      duration: typeof duration === 'string' ? duration : `${sig(duration ?? 0)}ms`,
    };
  }).sort((a, b) => b.ms - a.ms);
  return cap([
    `${n} traces, slowest first:`,
    ...rows.map((r) => `${r.id} root=${r.service} "${r.name}" start=${iso(r.start)} duration=${r.duration}`),
  ]);
};

/** One trace ("Trace" frame): services, errors and the spans with the most self time. */
export const summarizeTrace = (frames: DataFrame[]): string => {
  const f = frames.find((x) => col(x, 'spanID'));
  if (!f?.length) {
    return 'Trace not found (it may be outside the retention period or the id is wrong).';
  }
  const get = (name: string, i: number) => col(f, name)?.values[i];
  const spans = Array.from({ length: f.length }, (_, i) => ({
    id: String(get('spanID', i)),
    parent: String(get('parentSpanID', i) ?? ''),
    service: String(get('serviceName', i)),
    op: String(get('operationName', i)),
    start: Number(get('startTime', i)),
    dur: Number(get('duration', i)),
    error: Number(get('statusCode', i)) === 2,
    msg: String(get('statusMessage', i) ?? ''),
  }));
  // self time = duration minus the covered part of direct children (children may overlap; clamp at 0)
  const childTime = new Map<string, number>();
  for (const s of spans) {
    childTime.set(s.parent, (childTime.get(s.parent) ?? 0) + s.dur);
  }
  const root = spans.find((s) => !spans.some((p) => p.id === s.parent)) ?? spans[0];
  const perService = new Map<string, { spans: number; errors: number }>();
  for (const s of spans) {
    const e = perService.get(s.service) ?? { spans: 0, errors: 0 };
    e.spans++;
    e.errors += s.error ? 1 : 0;
    perService.set(s.service, e);
  }
  const self = spans
    .map((s) => ({ ...s, self: Math.max(0, s.dur - (childTime.get(s.id) ?? 0)) }))
    .sort((a, b) => b.self - a.self);
  const errors = spans.filter((s) => s.error);
  return cap([
    `${spans.length} spans. Root: ${root.service} "${root.op}" ${sig(root.dur)}ms starting ${iso(root.start)}`,
    `Services: ${[...perService].map(([k, v]) => `${k} (${v.spans} spans${v.errors ? `, ${v.errors} errors` : ''})`).join('; ')}`,
    `Most self time: ${self
      .slice(0, 10)
      .map((s) => `${s.service} "${s.op}" self=${sig(s.self)}ms total=${sig(s.dur)}ms`)
      .join('; ')}`,
    errors.length
      ? `Error spans: ${errors
          .slice(0, 20)
          .map((s) => `${s.service} "${s.op}"${s.msg ? `: ${s.msg}` : ''}`)
          .join('; ')}`
      : 'No error spans.',
  ]);
};
