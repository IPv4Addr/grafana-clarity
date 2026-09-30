// Runs before every test file (jest.config.js): the fake @grafana/runtime, reset before each test.
import { grafana, runtime } from './grafana';

jest.mock('@grafana/runtime', () => runtime);
beforeEach(grafana.reset);
