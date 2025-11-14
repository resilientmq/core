module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  displayName: 'benchmark',
  rootDir: '..',
  roots: ['<rootDir>/test/benchmark'],
  testMatch: [
    '**/?(*.)+(bench|benchmark).ts'
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: '<rootDir>/test-results',
      outputName: 'junit-benchmark.xml',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}',
      ancestorSeparator: ' › ',
      usePathForSuiteName: true
    }]
  ],
  verbose: true,
  testTimeout: 900000, // 15 minutes for benchmarks
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  maxWorkers: 1, // Run benchmarks serially for accurate measurements
  bail: false, // Continue running all benchmarks even if one fails
  cacheDirectory: '<rootDir>/.jest-cache/benchmark'
};
