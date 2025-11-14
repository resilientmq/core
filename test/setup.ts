/**
 * Global setup for Jest tests
 * This file is executed before all test suites
 */

// Set default test timeout (can be overridden by specific configs)
jest.setTimeout(30000);

// Suppress console output during tests unless there's an error
// Uncomment to reduce noise during test runs
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
// };

// Add custom matchers for testing
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () => `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },
  
  toHaveBeenCalledWithEvent(received: jest.Mock, eventType: string) {
    const calls = received.mock.calls;
    const pass = calls.some(call => call[0]?.type === eventType);
    if (pass) {
      return {
        message: () => `expected mock not to have been called with event type ${eventType}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected mock to have been called with event type ${eventType}`,
        pass: false,
      };
    }
  },
  
  toBeValidResilientEvent(received: any) {
    const hasRequiredFields = 
      received &&
      typeof received.id === 'string' &&
      typeof received.messageId === 'string' &&
      typeof received.type === 'string' &&
      received.payload !== undefined &&
      ['PENDING', 'PUBLISHED', 'PROCESSED', 'FAILED'].includes(received.status);
    
    if (hasRequiredFields) {
      return {
        message: () => `expected ${JSON.stringify(received)} not to be a valid ResilientEvent`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${JSON.stringify(received)} to be a valid ResilientEvent with id, messageId, type, payload, and status`,
        pass: false,
      };
    }
  }
});

// Global test helpers
global.sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to wait for a condition with timeout
global.waitFor = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> => {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await global.sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
};

// Helper to retry an async operation
global.retry = async <T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> => {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts) {
        await global.sleep(delayMs);
      }
    }
  }
  throw lastError || new Error('Retry failed');
};

// Ensure test-results directory exists
import * as fs from 'fs';
import * as path from 'path';

const testResultsDir = path.join(__dirname, '..', 'test-results');
if (!fs.existsSync(testResultsDir)) {
  fs.mkdirSync(testResultsDir, { recursive: true });
}

// Handle unhandled promise rejections and uncaught exceptions
// This prevents tests from crashing due to connection errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process, just log the error
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process, just log the error
});

// Export for use in tests
declare global {
  function sleep(ms: number): Promise<void>;
  function waitFor(
    condition: () => boolean | Promise<boolean>,
    timeoutMs?: number,
    intervalMs?: number
  ): Promise<void>;
  function retry<T>(
    fn: () => Promise<T>,
    maxAttempts?: number,
    delayMs?: number
  ): Promise<T>;
  
  namespace jest {
    interface Matchers<R> {
      toBeWithinRange(floor: number, ceiling: number): R;
      toHaveBeenCalledWithEvent(eventType: string): R;
      toBeValidResilientEvent(): R;
    }
  }
}
