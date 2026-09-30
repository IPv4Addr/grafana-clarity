// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

// Jest configuration provided by Grafana scaffolding
const config = require('./.config/jest.config');

module.exports = {
  ...config,
  testEnvironment: '<rootDir>/src/test/environment.ts',
  // after the scaffold's setup: the fake @grafana/runtime
  setupFilesAfterEnv: [...config.setupFilesAfterEnv, '<rootDir>/src/test/setup.ts'],
};
