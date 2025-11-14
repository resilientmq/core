module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  displayName: 'stress',
  rootDir: '..',
  roots: ['<rootDir>/test/stress'],
  testMatch: [
    '**/?(*.)+(spec|test).ts'
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: '<rootDir>/test-results',
      outputName: 'junit-stress.xml',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}',
      ancestorSeparator: ' › ',
      usePathForSuiteName: true
    }]
  ],
  verbose: true,
  testTimeout: 300000, // 5 minutes for stress tests
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  maxWorkers: 1, // Run stress tests serially
  cacheDirectory: '<rootDir>/.jest-cache/stress',
  detectOpenHandles: true
};
