import {
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  DataSourceJsonData,
  DataSourcePluginMeta,
  LiveChannelAddress,
  LiveChannelEvent,
} from '@grafana/data';
import type { JSDOM } from 'jsdom';
import { Observable, Subject, from } from 'rxjs';

// A controllable stand-in for @grafana/runtime (the real package does not load under Jest). setup.ts registers it
// for every test file and calls grafana.reset() before each test, so a test only sets up what it needs.

/** The URL window.location has at the start of every test. */
const HOME = 'http://localhost:3000/a/ipv4addr-clarity-app';

/**
 * Rejects like backend_srv does (with a FetchError-like object) for a request no test has faked; handy as the
 * fallback of a routing fake.
 */
const notFaked = (url: string): Promise<any> => Promise.reject({ status: 404, data: { message: `not faked: ${url}` } });

// every fake function, with the implementation reset() restores
const fakes: Array<[jest.Mock, (...args: any[]) => any]> = [];
const fake = <T extends (...args: any[]) => any>(impl: T) => {
  const m = jest.fn<ReturnType<T>, Parameters<T>>(impl);
  fakes.push([m, impl]);
  return m;
};

type Settings = DataSourceInstanceSettings<DataSourceJsonData & Record<string, unknown>>;

/** A datasource as getDataSourceSrv() returns it. Only uid and type are required; name defaults to the uid. */
export const fakeDatasource = (ds: Pick<Settings, 'uid' | 'type'> & Partial<Settings>): DataSourceInstanceSettings => ({
  id: 1,
  name: ds.uid,
  access: 'proxy',
  readOnly: false,
  jsonData: {},
  // the code under test never reads the plugin meta
  meta: { id: ds.type, name: ds.type } as DataSourcePluginMeta,
  ...ds,
});

// the datasources provisioned in the dev stack (provisioning/datasources/datasources.yaml)
const defaultDatasources = () => [
  fakeDatasource({
    uid: 'prometheus',
    name: 'Prometheus',
    type: 'prometheus',
    isDefault: true,
    jsonData: { timeInterval: '15s' },
  }),
  fakeDatasource({ uid: 'loki', name: 'Loki', type: 'loki' }),
  fakeDatasource({
    uid: 'tempo',
    name: 'Tempo',
    type: 'tempo',
    jsonData: {
      serviceMap: { datasourceUid: 'prometheus' },
      tracesToLogsV2: { datasourceUid: 'loki', filterByTraceID: true },
    },
  }),
];
const datasources: DataSourceInstanceSettings[] = [];

const backendSrv = {
  get: fake((url: string, ..._rest: any[]) => notFaked(url)),
};

// the query() of every datasource
const query = fake((request: DataQueryRequest): Observable<DataQueryResponse> | Promise<DataQueryResponse> =>
  from(notFaked(`query of ${request.targets[0]?.datasource?.uid}`))
);

// by uid or name
const settings = (key: string) => datasources.find((d) => d.uid === key || d.name === key);
const dataSourceSrv = {
  getInstanceSettings: settings,
  get: async (key: string) => {
    const ds = settings(key);
    if (!ds) {
      throw new Error(`Datasource ${key} was not found`);
    }
    // Prometheus' datasource takes its minimum interval from the scrape interval
    return {
      ...ds,
      interval: (ds.jsonData as Record<string, unknown>).timeInterval,
      query,
    } as unknown as DataSourceApi;
  },
  // sorted by name, like Grafana's
  getList: (filters: { type?: string | string[] } = {}) =>
    datasources
      .filter((d) => !filters.type || [filters.type].flat().includes(d.type))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
};

// one per getStream call, in call order
const streams: Array<Subject<LiveChannelEvent>> = [];
const liveSrv = {
  getStream: fake((_address: LiveChannelAddress): Observable<LiveChannelEvent> => {
    const events = new Subject<LiveChannelEvent>();
    streams.push(events);
    return events;
  }),
};

const hasPermission = fake((_action: string) => true);

/** Points window.location at another URL without navigating. */
export const setLocation = (url: string) => (globalThis as unknown as { jsdom: JSDOM }).jsdom.reconfigure({ url });

// reads the jsdom location, which setLocation() sets; no test navigates
const locationService = {
  getLocation: () => {
    const { pathname, search, hash } = document.location;
    return { pathname, search, hash, state: undefined };
  },
  getSearch: () => new URLSearchParams(document.location.search),
};

/** What setup.ts registers as the @grafana/runtime module. */
export const runtime = {
  getBackendSrv: () => backendSrv,
  getDataSourceSrv: () => dataSourceSrv,
  getGrafanaLiveSrv: () => liveSrv,
  hasPermission,
  locationService,
};

/** Test controls for the fake @grafana/runtime. Everything here is the live object the code under test sees. */
export const grafana = {
  /** getBackendSrv(): get rejects with notFaked(url). */
  backend: backendSrv,
  /** getDataSourceSrv() reads this list; push, splice or replace entries (see fakeDatasource). */
  datasources,
  /**
   * query() of the datasources getDataSourceSrv().get() returns: fails with notFaked. Return an Observable or a
   * Promise of the response, like a DataSourceApi.
   */
  query,
  hasPermission,
  notFaked,
  /**
   * getGrafanaLiveSrv(): getStream(address) returns a new Subject, which the test drives through `streams` (in call
   * order; `subject.observed` turns false once the code unsubscribes). Replace getStream's implementation to return
   * another Observable.
   */
  live: { getStream: liveSrv.getStream, streams },
  /** Restores every default: fakes, datasources, Live streams and window.location (HOME). Runs before each test. */
  reset: () => {
    for (const [m, impl] of fakes) {
      m.mockReset();
      m.mockImplementation(impl);
    }
    datasources.splice(0, datasources.length, ...defaultDatasources());
    streams.length = 0;
    setLocation(HOME);
  },
};
