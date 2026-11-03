/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: ['<rootDir>/packages/*/test/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  // Tests run against package sources, not build output.
  moduleNameMapper: {
    '^@open-estate/([^/]+)$': '<rootDir>/packages/$1/src',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Per-run TMPDIR: catches the `cdk.out*` dirs of CDK apps synthesized without an `outdir`.
  globalSetup: '<rootDir>/jest.global-setup.js',
  globalTeardown: '<rootDir>/jest.global-teardown.js',
  collectCoverageFrom: ['packages/*/src/**/*.ts'],
};
