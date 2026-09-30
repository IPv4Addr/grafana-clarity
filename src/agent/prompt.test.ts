import { fakeDatasource, grafana, setLocation } from '../test/grafana';
import { AgentUI, runTool } from './llm';
import { RESUME, SYSTEM, context } from './prompt';
import { splitFollowUps } from './store';
import { TOOLS } from './tools';

describe('context', () => {
  beforeEach(() => jest.useFakeTimers({ now: Date.parse('2026-09-30T12:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  /** The "current Grafana page" line of the context. */
  const page = () => context().split('\n')[1];

  it('gives the time, the page and the datasources the model can query', () => {
    grafana.datasources.push(
      fakeDatasource({ uid: 'es', name: 'Elasticsearch', type: 'elasticsearch' }),
      fakeDatasource({ uid: 'tempo-eu', name: 'Tempo EU', type: 'tempo' })
    );
    setLocation('http://localhost:3000/d/hotrod/hotrod?orgId=1&from=now-1h');
    expect(context()).toBe(
      [
        `now: 2026-09-30T12:00:00.000Z (user timezone ${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
        'current Grafana page: /d/hotrod/hotrod?orgId=1&from=now-1h',
        'datasources:',
        '- loki "Loki" uid=loki',
        '- prometheus "Prometheus" uid=prometheus (default)',
        '- tempo "Tempo" uid=tempo serviceMapPrometheusUid=prometheus logsLokiUid=loki',
        '- tempo "Tempo EU" uid=tempo-eu serviceMapPrometheusUid=- logsLokiUid=-',
      ].join('\n')
    );
  });

  it('says when the user can query no datasource', () => {
    grafana.datasources.length = 0;
    expect(context().endsWith('\ndatasources:\n(none the user can query)')).toBe(true);
  });

  it('never sends the auth_token of a JWT URL login', () => {
    setLocation('http://localhost:3000/d/abc/payments?auth_token=eyJhbGciOiJSUzI1NiJ9.e30.sig&var-service=api');
    expect(page()).toBe('current Grafana page: /d/abc/payments?var-service=api');
    setLocation('http://localhost:3000/d/abc/payments?auth_token=eyJhbGciOiJSUzI1NiJ9.e30.sig');
    expect(page()).toBe('current Grafana page: /d/abc/payments');
  });

  it('decodes the page URL, and keeps it as is when it has a stray %', () => {
    setLocation('http://localhost:3000/explore?left=%7B%22datasource%22%3A%22loki%22%7D');
    expect(page()).toBe('current Grafana page: /explore?left={"datasource":"loki"}');
    setLocation('http://localhost:3000/d/abc/cpu-100%');
    expect(page()).toBe('current Grafana page: /d/abc/cpu-100%');
  });

  it('cuts a long page URL at 400 characters', () => {
    setLocation(`http://localhost:3000/explore?left=${'a'.repeat(1000)}`);
    expect(page()).toBe(`current Grafana page: ${`/explore?left=${'a'.repeat(1000)}`.slice(0, 400)}`);
  });
});

describe('prompts', () => {
  it('asks for follow-ups in the format the chat parses', () => {
    const format = SYSTEM.match(/"(Follow-ups: [^"]+)"/)?.[1];
    expect(format).toBe('Follow-ups: <question> | <question> | <question>');
    let n = 0;
    const answer = `Payments is down.\n\n${format!.replace(/<question>/g, () => `Question ${++n}?`)}`;
    expect(splitFollowUps(answer)).toEqual({
      body: 'Payments is down.',
      followUps: ['Question 1?', 'Question 2?', 'Question 3?'],
    });
  });

  it('only names tools the model has', () => {
    const named = new Set(SYSTEM.match(/\b(?:get|list|query|search)_\w+/g));
    expect(named.size).toBeGreaterThan(0);
    expect(TOOLS.map((t) => t.function.name)).toEqual(expect.arrayContaining([...named]));
  });

  it('tells the model to rerun the tool calls that were stopped', async () => {
    const stop = new AbortController();
    stop.abort();
    const ui = { toolResult: () => {} } as unknown as AgentUI;
    // what a tool call cut off by Stop returns to the model
    const { content } = await runTool({ id: 't1', name: 'get_alerts', input: {} }, ui, stop.signal);
    expect(content.startsWith('Stopped')).toBe(true);
    expect(RESUME).toContain('Tool results that say they were stopped did not run: run them again');
  });
});
