module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  displayName: 'unit',
  rootDir: '..',
  roots: ['<rootDir>/test/unit'],
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
  coverageDirectory: '<rootDir>/coverage/unit',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: '<rootDir>/test-results',
      outputName: 'junit-unit.xml',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}',
      ancestorSeparator: ' › ',
      usePathForSuiteName: true
    }]
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 75,
      statements: 75
    }
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
  testTimeout: 5000, // 5 seconds for unit tests
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  cacheDirectory: '<rootDir>/.jest-cache/unit',
  maxWorkers: '50%', // Use 50% of available CPU cores for parallel execution
  detectOpenHandles: true
};
