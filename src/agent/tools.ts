import {
  DataFrame,
  DataQueryRequest,
  DataQueryResponse,
  DataTopic,
  DataSourceInstanceSettings,
  FieldType,
  TimeRange,
  createDataFrame,
  dateMath,
  dateTime,
  locationUtil,
  rangeUtil,
  urlUtil,
} from '@grafana/data';
import { getBackendSrv, getDataSourceSrv, hasPermission } from '@grafana/runtime';
import { from, fromEvent, lastValueFrom, takeUntil } from 'rxjs';
import pluginJson from '../plugin.json';
import { summarizeInstant, summarizeLogs, summarizeSeries, summarizeTrace, summarizeTraceSearch } from './summarize';

// Every tool runs in the browser through Grafana's HTTP API as the logged-in user, so Grafana RBAC applies.
// The model gets compact text (forModel); the frames stay here and are rendered as native panels (view).

/** How the chat renders a tool result: a native Grafana panel, plus a link to the query in Explore. */
export interface ToolView {
  panel: 'timeseries' | 'table' | 'logs' | 'traces' | 'bargauge';
  frames: DataFrame[];
  timeRange: TimeRange;
  height: number;
  explore?: string;
}
/** A successful tool run. */
export interface ToolOutcome {
  forModel: string;
  view?: ToolView;
}

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const clamp = (v: unknown, def: number, max: number) => Math.min(max, Math.max(1, Math.round(Number(v) || def)));

// ---------- helpers ----------

const timeRange = (start: unknown, end: unknown): TimeRange => {
  const now = dateTime();
  const [rawFrom, rawTo] = [str(start) ?? 'now-1h', str(end) ?? 'now'];
  const from = dateMath.toDateTime(rawFrom, { now });
  const to = dateMath.toDateTime(rawTo, { now, roundUp: true });
  if (!from?.isValid() || !to?.isValid()) {
    throw new Error(`Invalid time "${rawFrom}" / "${rawTo}". Use Grafana relative time (now-1h) or RFC3339 with Z.`);
  }
  if (from.valueOf() > to.valueOf()) {
    throw new Error(`start (${rawFrom}) must be before end (${rawTo}).`);
  }
  if (from.valueOf() === to.valueOf()) {
    // models pass start = end = now for "right now" (instant queries): look at the hour up to that point
    return { from: dateTime(to).subtract(1, 'hour'), to, raw: { from: `${rawTo}-1h`, to: rawTo } };
  }
  return { from, to, raw: { from: rawFrom, to: rawTo } };
};
const rangeText = (tr: TimeRange) => `Time range ${tr.from.toISOString()} to ${tr.to.toISOString()}.`;

const datasource = (uid: unknown, type: string): DataSourceInstanceSettings => {
  const ds = getDataSourceSrv().getInstanceSettings(String(uid));
  if (!ds || ds.uid !== uid || ds.type !== type) {
    const known = getDataSourceSrv()
      .getList({ type })
      .map((d) => `${d.name} (uid ${d.uid})`);
    throw new Error(`No ${type} datasource with uid "${uid}". Available: ${known.join(', ') || 'none'}.`);
  }
  return ds;
};

let requests = 0;

/**
 * Runs one query through the datasource's own query(), like a panel does, and returns the frames of its final
 * response: Loki query splitting and Tempo streaming emit partial ones first.
 */
const dsQuery = async (ds: DataSourceInstanceSettings, query: object, range: TimeRange, signal: AbortSignal) => {
  const api = await getDataSourceSrv().get(ds.uid);
  const maxDataPoints = 200;
  const request: DataQueryRequest = {
    // Grafana cancels a request still running when another one with the same requestId starts
    requestId: `clarity-${++requests}`,
    app: pluginJson.id,
    targets: [{ refId: 'A', datasource: { type: ds.type, uid: ds.uid }, ...query }],
    range,
    maxDataPoints,
    // at least the datasource's minimum interval (the scrape interval for Prometheus)
    ...rangeUtil.calculateInterval(range, maxDataPoints, api.interval),
    scopedVars: {},
    timezone: 'utc',
    startTime: Date.now(),
  };
  let res: DataQueryResponse | undefined;
  try {
    res = await lastValueFrom(from(api.query(request)).pipe(takeUntil(fromEvent(signal, 'abort'))), {
      defaultValue: undefined,
    });
  } catch (e: any) {
    throw new Error(e?.data?.message ?? e?.message ?? 'Query failed');
  }
  if (signal.aborted) {
    throw new Error('Stopped.');
  }
  // a refused request and Tempo's own errors come only in the deprecated `error`
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const errors = res?.errors?.length ? res.errors : res?.error ? [res.error] : [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join('; ') || 'Query failed');
  }
  // exemplars come back as annotation frames; they are not series (Grafana's own query runner splits them off too)
  return ((res?.data ?? []) as DataFrame[]).filter((f) => f.meta?.dataTopic !== DataTopic.Annotations);
};

const resource = <T>(ds: DataSourceInstanceSettings, path: string, params: Input, signal?: AbortSignal) =>
  getBackendSrv().get<T>(`/api/datasources/uid/${ds.uid}/resources/${path}`, params, undefined, {
    showErrorAlert: false,
    abortSignal: signal,
  });

const exploreUrl = (ds: DataSourceInstanceSettings, query: object, tr: TimeRange) => {
  if (!hasPermission('datasources:explore')) {
    return undefined;
  }
  const panes = {
    llm: {
      datasource: ds.uid,
      queries: [{ refId: 'A', datasource: { type: ds.type, uid: ds.uid }, ...query }],
      range: { from: String(tr.from.valueOf()), to: String(tr.to.valueOf()) },
    },
  };
  return locationUtil.assureBaseUrl(urlUtil.renderUrl('/explore', { schemaVersion: 1, panes: JSON.stringify(panes) }));
};

const listValues = (values: string[], regex?: string, max = 200) => {
  let re: RegExp | undefined;
  try {
    // models write PromQL/RE2 style, where (?i) makes the rest case-insensitive
    re = regex ? new RegExp(regex.replace(/^\(\?i\)/, ''), regex.startsWith('(?i)') ? 'i' : '') : undefined;
  } catch {
    throw new Error(`Invalid regex "${regex}"`);
  }
  const hits = values.filter((v) => !re || re.test(v)).sort();
  return `${hits.length} values${hits.length > max ? ` (showing ${max})` : ''}: ${hits.slice(0, max).join(', ') || '(none)'}`;
};

// ---------- tools ----------

/**
 * Alert rules evaluated by a Prometheus/Mimir or Loki ruler ("datasource-managed"), read through Grafana. Datasources
 * without a ruler just fail and are skipped. Same shape as Grafana's rules, but instance values are query results.
 */
const rulerRules = async (states: string[], search: string | undefined, signal: AbortSignal) => {
  const words = (search ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const sources = getDataSourceSrv()
    .getList()
    .filter((ds) => ['prometheus', 'loki'].includes(ds.type) && (ds.jsonData as any)?.manageAlerts !== false);
  const perSource = await Promise.all(
    sources.map((ds) =>
      getBackendSrv()
        .get<any>(`/api/prometheus/${ds.uid}/api/v1/rules`, { type: 'alert' }, undefined, {
          showErrorAlert: false,
          abortSignal: signal,
        })
        .then((res) =>
          (res?.data?.groups ?? []).flatMap((g: any) =>
            g.rules
              .filter((r: any) => r.type === 'alerting')
              .map((r: any) => ({
                ...r,
                source: `${ds.name} ruler`,
                uid: `${ds.uid}/${g.file}/${g.name}/${r.name}`,
                group: g.name,
                folder: g.file,
                queriedDatasourceUIDs: [ds.uid],
                alerts: (r.alerts ?? []).slice(0, 10),
                activeAt: r.activeAt ?? r.alerts?.[0]?.activeAt,
              }))
          )
        )
        .catch(() => [])
    )
  );
  return perSource
    .flat()
    .filter((r: any) => states.includes(r.state) || r.health === 'err')
    .filter((r: any) => words.every((w) => r.name.toLowerCase().includes(w)));
};

const getAlerts = async (input: Input, signal: AbortSignal): Promise<ToolOutcome> => {
  const get = (params: Input) =>
    getBackendSrv().get<any>('/api/prometheus/grafana/api/v1/rules', { rule_type: 'alerting', ...params }, undefined, {
      showErrorAlert: false,
      abortSignal: signal,
    });
  const ruleUid = str(input.ruleUid);
  const states = (input.states as string[] | undefined) ?? ['firing', 'pending'];
  const ruler = ruleUid ? Promise.resolve([]) : rulerRules(states, str(input.search), signal);
  const [byState, broken] = await Promise.all([
    get({
      state: ruleUid ? undefined : ((input.states as string[] | undefined) ?? ['firing', 'pending']),
      rule_uid: ruleUid,
      'search.rule_name': str(input.search),
      limit_alerts: 10,
    }),
    // rules that cannot evaluate (datasource down, bad query) are often the real root cause
    ruleUid
      ? { data: { groups: [] } }
      : get({ health: ['error', 'nodata'], 'search.rule_name': str(input.search), limit_alerts: 3 }),
  ]);
  const seen = new Set<string>();
  const rules = [
    ...[...byState.data.groups, ...broken.data.groups].flatMap((g: any) =>
      g.rules.map((r: any) => ({
        ...r,
        source: 'Grafana',
        group: g.name,
        folder: g.file,
        activeAt: r.activeAt ?? r.alerts?.[0]?.activeAt,
      }))
    ),
    ...(await ruler),
  ]
    .filter((r: any) => !seen.has(r.uid) && seen.add(r.uid))
    .sort((a: any, b: any) => String(a.activeAt ?? '9').localeCompare(String(b.activeAt ?? '9')));

  const lines = rules.slice(0, 25).map((r: any) => {
    const ann = r.annotations ?? {};
    const inst = (r.alerts ?? [])
      .map(
        (a: any) =>
          `{${Object.entries(a.labels ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(
              ', '
            )}} ${a.state} ${r.source === 'Grafana' ? 'condition' : 'value'}=${a.value ?? '-'} since ${a.activeAt}`
      )
      .join('\n    ');
    return [
      `- ${String(r.state).toUpperCase()}${r.activeAt ? ` since ${r.activeAt}` : ''} "${r.name}" source=${r.source} uid=${r.uid} folder="${r.folder}" group="${r.group}" for=${r.duration ?? 0}s health=${r.health}${r.lastError ? ` lastError="${r.lastError}"` : ''}`,
      `  labels: ${JSON.stringify(r.labels ?? {})}`,
      ...['summary', 'description', 'runbook_url'].filter((k) => ann[k]).map((k) => `  ${k}: ${ann[k]}`),
      `  query [${(r.queriedDatasourceUIDs ?? []).join(', ')}]: ${r.query}`,
      inst
        ? `  instances (${r.totals ? JSON.stringify(r.totals) : r.alerts.length}):\n    ${inst}`
        : '  no active instances',
    ].join('\n');
  });

  if (ruleUid) {
    const def = await getBackendSrv()
      .get<any>(`/api/ruler/grafana/api/v1/rule/${encodeURIComponent(ruleUid)}`, undefined, undefined, {
        showErrorAlert: false,
        abortSignal: signal,
      })
      .catch(() => undefined);
    const ga = def?.grafana_alert;
    if (ga) {
      lines.push(
        `Definition: condition=${ga.condition} for=${def.for} noData=${ga.no_data_state} execErr=${ga.exec_err_state}`,
        ...ga.data.map(
          (d: any) =>
            `  ${d.refId} [${d.datasourceUid}] last ${d.relativeTimeRange?.from ?? 0}s: ${d.model?.expr ?? JSON.stringify({ type: d.model?.type, expression: d.model?.expression, conditions: d.model?.conditions, reducer: d.model?.reducer })}`
        )
      );
    }
  }

  const header = ruleUid
    ? `Alert rule ${ruleUid}:`
    : `${rules.length} alert rules (states ${JSON.stringify(states)} plus rules with health error/nodata; Grafana-managed and from Prometheus/Mimir/Loki rulers), earliest first${rules.length > 25 ? ', showing 25' : ''}:`;
  const now = dateTime();
  return {
    forModel: rules.length ? [header, ...lines].join('\n') : 'No matching alert rules.',
    view: rules.length
      ? {
          panel: 'table',
          height: Math.min(80 + rules.length * 36, 320),
          timeRange: { from: now, to: now, raw: { from: 'now', to: 'now' } },
          frames: [
            createDataFrame({
              fields: [
                { name: 'State', type: FieldType.string, values: rules.map((r: any) => r.state) },
                { name: 'Rule', type: FieldType.string, values: rules.map((r: any) => r.name) },
                { name: 'Source', type: FieldType.string, values: rules.map((r: any) => r.source) },
                {
                  name: 'Since',
                  type: FieldType.time,
                  values: rules.map((r: any) => (r.activeAt ? Date.parse(r.activeAt) : null)),
                },
                { name: 'Health', type: FieldType.string, values: rules.map((r: any) => r.health) },
                {
                  name: 'Instances',
                  type: FieldType.number,
                  values: rules.map((r: any) => {
                    // the alerts array is capped by limit_alerts; totalsFiltered has the real count, but counts
                    // an instance twice (its state + "error") when its evaluation failed
                    const { error = 0, ...states } = (r.totalsFiltered ?? {}) as Record<string, number>;
                    return Object.values(states).reduce((a, b) => a + b, 0) || error || (r.alerts?.length ?? 0);
                  }),
                },
                {
                  name: 'Summary',
                  type: FieldType.string,
                  values: rules.map((r: any) => r.annotations?.summary ?? ''),
                },
              ],
            }),
          ],
        }
      : undefined,
  };
};

const queryPrometheus = async (input: Input, signal: AbortSignal): Promise<ToolOutcome> => {
  const ds = datasource(input.datasourceUid, 'prometheus');
  const tr = timeRange(input.start, input.end);
  const instant = input.queryType === 'instant';
  const query = { expr: String(input.expr), instant, range: !instant, editorMode: 'code', legendFormat: '__auto' };
  const frames = await dsQuery(ds, query, tr, signal);
  return {
    forModel: `${rangeText(tr)}\n${instant ? summarizeInstant(frames) : summarizeSeries(frames)}`,
    view: {
      panel: instant ? 'bargauge' : 'timeseries',
      frames,
      timeRange: tr,
      height: instant ? Math.min(60 + frames.length * 28, 320) : 220,
      explore: exploreUrl(ds, query, tr),
    },
  };
};

const listPrometheusLabels = async (input: Input, signal: AbortSignal): Promise<ToolOutcome> => {
  const ds = datasource(input.datasourceUid, 'prometheus');
  const tr = timeRange(input.start, input.end);
  const label = str(input.label);
  const params = {
    'match[]': str(input.match),
    start: Math.floor(tr.from.valueOf() / 1000),
    end: Math.ceil(tr.to.valueOf() / 1000),
  };
  const path = label ? `api/v1/label/${encodeURIComponent(label)}/values` : 'api/v1/labels';
  const res = await resource<{ data: string[] }>(ds, path, params, signal);
  return {
    forModel: `${label ? `Values of ${label}` : 'Label names'}: ${listValues(res.data ?? [], str(input.regex))}`,
  };
};

const isLogFrame = (f: DataFrame) =>
  f.meta?.type === 'log-lines' || (f.meta?.custom as any)?.frameType === 'LabeledTimeValues';

const queryLoki = async (input: Input, signal: AbortSignal): Promise<ToolOutcome> => {
  const ds = datasource(input.datasourceUid, 'loki');
  const tr = timeRange(input.start, input.end);
  const limit = clamp(input.limit, 50, 200);
  // ~200 points, at least 1s apart (without a step, Loki uses the request's interval, which can be finer)
  const step = `${Math.max(1, Math.ceil((tr.to.valueOf() - tr.from.valueOf()) / 200 / 1000))}s`;
  const query = { expr: String(input.logql), queryType: 'range', editorMode: 'code' };
  const frames = await dsQuery(ds, { maxLines: limit, direction: 'backward', step, ...query }, tr, signal);
  const logs = frames.some(isLogFrame);
  return {
    forModel: `${rangeText(tr)}\n${logs ? summarizeLogs(frames, limit) : summarizeSeries(frames)}`,
    view: {
      panel: logs ? 'logs' : 'timeseries',
      frames,
      timeRange: tr,
      height: logs ? 320 : 220,
      explore: exploreUrl(ds, query, tr),
    },
  };
};

const listLokiLabels = async (input: Input, signal: AbortSignal): Promise<ToolOutcome> => {
  const ds = datasource(input.datasourceUid, 'loki');
  const tr = timeRange(input.start, input.end);
  const label = str(input.label);
  const match = str(input.match)?.replace(/^\{\s*\}$/, ''); // Loki rejects {} ("at least one matcher")
  const params = { query: match || undefined, start: tr.from.valueOf() * 1e6, end: tr.to.valueOf() * 1e6 };
  const res = await resource<{ data: string[] }>(
    ds,
    label ? `label/${encodeURIComponent(label)}/values` : 'labels',
    params,
    signal
  );
  return { forModel: `${label ? `Values of ${label}` : 'Label names'}: ${listValues(res.data ?? [])}` };
};

const searchTraces = async (input: Input, signal: AbortSignal): Promise<ToolOutcome> => {
  const ds = datasource(input.datasourceUid, 'tempo');
  const tr = timeRange(input.start, input.end);
  const query = {
    queryType: 'traceql',
    query: String(input.traceql),
    limit: clamp(input.limit, 20, 50),
    spss: 3,
    tableType: 'traces',
  };
  const frames = await dsQuery(ds, query, tr, signal);
  const search = frames.find((f) => f.name === 'Traces');
  if (!search) {
    // TraceQL metrics query ({...} | rate() ...) returns time series
    return {
      forModel: `${rangeText(tr)}\n${summarizeSeries(frames)}`,
      view: { panel: 'timeseries', frames, timeRange: tr, height: 220, explore: exploreUrl(ds, query, tr) },
    };
  }
  // Tempo's trace-id link opens with target=_self, a full page reload that would wipe the conversation, and the
  // span sets (nested) link their spans the same way; the table only shows the traces, the card's Explore button
  // covers navigation
  const table = {
    ...search,
    fields: search.fields.filter((f) => f.name !== 'nested').map((f) => ({ ...f, config: { ...f.config, links: [] } })),
  };
  return {
    forModel: `${rangeText(tr)}\n${summarizeTraceSearch([search])}`,
    view: {
      panel: 'table',
      frames: [table],
      timeRange: tr,
      height: Math.min(80 + search.length * 36, 320),
      explore: exploreUrl(ds, query, tr),
    },
  };
};

const getTrace = async (input: Input, signal: AbortSignal): Promise<ToolOutcome> => {
  const ds = datasource(input.datasourceUid, 'tempo');
  const traceId = String(input.traceId).trim();
  if (!/^[0-9a-fA-F]{1,32}$/.test(traceId)) {
    throw new Error(`"${traceId}" is not a hex trace id.`);
  }
  // A TraceQL query of only hex digits is a trace lookup. Tempo ignores the time range unless the datasource
  // time-shifts trace queries; then it searches around this hour, like Explore (where the link opens) does.
  const query = { queryType: 'traceql', query: traceId };
  const hour = timeRange('now-1h', 'now');
  const frames = await dsQuery(ds, query, hour, signal);
  const now = dateTime();
  const tr = { from: now, to: now, raw: { from: 'now', to: 'now' } };
  return {
    forModel: summarizeTrace(frames),
    // not found: an empty trace frame
    view: frames.some((f) => f.length)
      ? { panel: 'traces', frames, timeRange: tr, height: 460, explore: exploreUrl(ds, query, hour) }
      : undefined,
  };
};

// ---------- definitions (fixed order: they are part of the cached prompt prefix) ----------

const time = {
  start: { type: 'string', description: 'Start: Grafana relative time (now-1h, now-30m) or RFC3339 with Z' },
  end: { type: 'string', description: 'End: usually now' },
};
const dsUid = (type: string) => ({ type: 'string', description: `uid of a ${type} datasource from the context` });
const schema = (properties: Record<string, object>, required: string[]) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});

/** A tool definition in the Chat Completions format, which the Grafana LLM app takes for every provider. */
export interface Tool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

const DEFINITIONS: Array<Tool['function']> = [
  {
    name: 'get_alerts',
    description:
      'List alert rules with their live alert instances, earliest first, plus any rules that are failing to evaluate: Grafana-managed ' +
      'rules and rules evaluated by Prometheus/Mimir/Loki rulers (source=... tells which). ' +
      'Use it first when the user asks what is broken, why an alert fires, or for the scope of an incident. Each rule includes state, ' +
      'health, labels, annotations, its query expression and the datasource uids it queries. Pass ruleUid to also get the full ' +
      'condition (reduce/threshold expressions). An instance "condition" value is the result of the alert condition (1 = firing), not the ' +
      'queried metric; for ruler rules it is the query result. ' +
      'To see why and when a rule crossed its threshold, re-run its query as a range query from about 30m before activeAt.',
    parameters: schema(
      {
        states: {
          type: 'array',
          items: { type: 'string', enum: ['firing', 'pending', 'recovering', 'inactive'] },
          description: 'Rule states to include (default firing and pending)',
        },
        search: { type: 'string', description: 'Words that must appear in the rule title' },
        ruleUid: { type: 'string', description: 'Fetch this one rule with its full definition' },
      },
      []
    ),
  },
  {
    name: 'query_prometheus',
    description:
      'Run PromQL against a Prometheus/Mimir datasource (Tempo span metrics and service graph metrics live there too). Returns a ' +
      'per-series summary (labels, min/max/avg/last, time of max, 12-point shape), not raw samples; the user sees the full result as a graph. ' +
      'queryType "instant" for the value right now and top-N (wrap in topk), "range" to see how it changed and when something started. ' +
      'Aggregate high-cardinality metrics with sum by (...). Check metric and label names with list_prometheus_labels instead of guessing.',
    parameters: schema(
      {
        datasourceUid: dsUid('prometheus'),
        expr: { type: 'string', description: 'PromQL expression' },
        queryType: { type: 'string', enum: ['range', 'instant'] },
        ...time,
      },
      ['datasourceUid', 'expr', 'queryType', 'start', 'end']
    ),
  },
  {
    name: 'list_prometheus_labels',
    description:
      'Discover what exists before querying Prometheus. Without label: the label names on series matching match. With label "__name__": ' +
      'metric names (filter with regex, e.g. "_bucket$" or "http_.*_total"). With any other label: its values, e.g. label "service" with ' +
      'match "traces_spanmetrics_calls_total" lists the services that send traces.',
    parameters: schema(
      {
        datasourceUid: dsUid('prometheus'),
        label: { type: 'string', description: 'Label to list values of; omit to list label names' },
        match: { type: 'string', description: 'Series selector, e.g. up or {job="api"}' },
        regex: { type: 'string', description: 'JavaScript regex to filter the returned values' },
        ...time,
      },
      ['datasourceUid', 'start', 'end']
    ),
  },
  {
    name: 'query_loki',
    description:
      'Run LogQL against Loki. Log queries return the newest lines first (default 50, max 200) with common labels shown once and ' +
      'repeated lines collapsed; the user sees them in a logs panel. Metric queries (count_over_time, rate, sum by) return the same ' +
      'per-series summary as query_prometheus: prefer them to count or compare errors across services, and fetch raw lines to read ' +
      'concrete errors. Always use a selective stream selector with a positive matcher, never {} or =~".*". ' +
      'To find the logs of a trace: {service_name="x"} |= "<traceId>".',
    parameters: schema(
      {
        datasourceUid: dsUid('loki'),
        logql: { type: 'string', description: 'LogQL query' },
        limit: { type: 'integer', description: 'Max log lines (default 50, max 200)' },
        ...time,
      },
      ['datasourceUid', 'logql', 'start', 'end']
    ),
  },
  {
    name: 'list_loki_labels',
    description:
      'Discover Loki stream labels. Without label: label names. With label: its values (e.g. label "service_name" lists the services that send logs). ' +
      'match is an optional stream selector to narrow the result.',
    parameters: schema(
      {
        datasourceUid: dsUid('loki'),
        label: { type: 'string', description: 'Label to list values of; omit to list label names' },
        match: { type: 'string', description: 'Stream selector, e.g. {service_name="api"}' },
        ...time,
      },
      ['datasourceUid', 'start', 'end']
    ),
  },
  {
    name: 'search_traces',
    description:
      'Search Tempo with TraceQL. Returns matching traces, slowest first: trace id, root service and operation, start, duration. ' +
      'Use it for slow requests ({ resource.service.name = "x" && duration > 500ms }), failures ({ status = error }) or cross-service ' +
      'questions ({ resource.service.name = "frontend" } >> { status = error }), then call get_trace on the most relevant id. ' +
      'For rates and percentiles over time use span metrics with query_prometheus instead.',
    parameters: schema(
      {
        datasourceUid: dsUid('tempo'),
        traceql: { type: 'string', description: 'TraceQL query' },
        limit: { type: 'integer', description: 'Max traces (default 20, max 50)' },
        ...time,
      },
      ['datasourceUid', 'traceql', 'start', 'end']
    ),
  },
  {
    name: 'get_trace',
    description:
      'Fetch one trace by id and summarize it: services involved with span and error counts, the root span and total duration, error ' +
      'spans with their status message, and the spans with the most self time (the real bottleneck, not just the longest parent). ' +
      'The user sees the full trace in the trace view.',
    parameters: schema({ datasourceUid: dsUid('tempo'), traceId: { type: 'string', description: 'Hex trace id' } }, [
      'datasourceUid',
      'traceId',
    ]),
  },
];

/** The tools the model can call. */
export const TOOLS: Tool[] = DEFINITIONS.map((f) => ({ type: 'function', function: f }));

const RUN: Record<string, (input: Input, signal: AbortSignal) => Promise<ToolOutcome>> = {
  get_alerts: getAlerts,
  query_prometheus: queryPrometheus,
  list_prometheus_labels: listPrometheusLabels,
  query_loki: queryLoki,
  list_loki_labels: listLokiLabels,
  search_traces: searchTraces,
  get_trace: getTrace,
};

/** Runs a tool call from the model. Rejects with the reason on bad input, a failed query or an unknown tool. */
export const executeTool = (name: string, input: unknown, signal: AbortSignal): Promise<ToolOutcome> => {
  const run = RUN[name];
  if (!run) {
    return Promise.reject(new Error(`Unknown tool ${name}`));
  }
  return run((input ?? {}) as Input, signal);
};

/** Human label for a tool call, e.g. for the tool card header. */
export const describeCall = (name: string, input: Input): { title: string; code?: string } => {
  const ds = str(input.datasourceUid)
    ? getDataSourceSrv().getInstanceSettings(String(input.datasourceUid))?.name
    : undefined;
  const on = ds ? ` · ${ds}` : '';
  switch (name) {
    case 'get_alerts':
      return { title: input.ruleUid ? `Alert rule ${input.ruleUid}` : 'Firing alerts' };
    case 'query_prometheus':
      return { title: `PromQL${on}`, code: String(input.expr ?? '') };
    case 'query_loki':
      return { title: `LogQL${on}`, code: String(input.logql ?? '') };
    case 'search_traces':
      return { title: `TraceQL${on}`, code: String(input.traceql ?? '') };
    case 'get_trace':
      return { title: `Trace${on}`, code: String(input.traceId ?? '') };
    case 'list_prometheus_labels':
    case 'list_loki_labels':
      return {
        title: `${input.label ? `Values of ${input.label}` : 'Label names'}${on}`,
        code: str(input.match),
      };
    default:
      return { title: name };
  }
};
