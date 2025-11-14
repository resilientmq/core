/**
 * Shared configuration for integration tests
 */
export const TEST_CONFIG = {
    // Timeouts optimized for faster tests
    CONSUMER_READY_DELAY: 500, // Time to wait for consumer to be ready
    MESSAGE_PROCESSING_DELAY: 2000, // Time to wait for message processing
    RETRY_TTL: 1000, // 1 second TTL for retry tests
    MAX_ATTEMPTS: 3, // Maximum retry attempts
    RECONNECT_DELAY: 1000, // Reconnection delay
    
    // Test queue names
    QUEUES: {
        BASIC: 'test.basic.queue',
        RETRY: 'test.retry.queue',
        RETRY_DLX: 'test.retry.queue.retry',
        DLQ: 'test.dlq.queue',
        DLQ_DLX: 'test.dlq.queue.dlq',
    },
    
    // Test exchange names
    EXCHANGES: {
        RETRY: 'test.retry.exchange',
        DLQ: 'test.dlq.exchange',
    }
};

/**
 * Generate unique queue name for test to avoid conflicts
 */
export function uniqueQueueName(baseName: string): string {
    return `${baseName}.${Date.now()}.${Math.random().toString(36).substring(7)}`;
}
