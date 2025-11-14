module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  displayName: 'integration',
  rootDir: '..',
  roots: ['<rootDir>/test/integration'],
  testMatch: [
    '**/?(*.)+(spec|test).ts'
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  collectCoverageFrom: [
    '<rootDir>/src/**/*.ts',
    '!<rootDir>/src/**/*.d.ts',
    '!<rootDir>/src/index.ts',
    '!<rootDir>/src/types/**/*.ts'
  ],
  coverageDirectory: '<rootDir>/coverage/integration',
  coverageReporters: ['text', 'lcov', 'html'],
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: '<rootDir>/test-results',
      outputName: 'junit-integration.xml',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}',
      ancestorSeparator: ' › ',
      usePathForSuiteName: true
    }]
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
  testTimeout: 60000, // 60 seconds for integration tests
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  maxWorkers: 1, // Run integration tests serially to avoid port conflicts
  cacheDirectory: '<rootDir>/.jest-cache/integration',
  detectOpenHandles: true
};
