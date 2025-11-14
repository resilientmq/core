/**
 * Utility functions for interacting with RabbitMQ in integration tests.
 * Provides helpers for queue management, message inspection, and connection testing.
 */
export class RabbitMQHelpers {
    private connectionUrl: string;
    private connection: any = null;
    private channel: any = null;

    constructor(connectionUrl: string) {
        this.connectionUrl = connectionUrl;
    }

    /**
     * Initializes a connection and channel for helper operations.
     * @private
     */
    private async ensureChannel(): Promise<any> {
        if (!this.connection) {
            const amqp = await import('amqplib');
            this.connection = await amqp.connect(this.connectionUrl);
        }
        if (!this.channel) {
            this.channel = await this.connection.createChannel();
        }
        return this.channel;
    }

    /**
     * Purges all messages from a specific queue.
     * @param queue Queue name to purge
     */
    async purgeQueue(queue: string): Promise<void> {
        const channel = await this.ensureChannel();
        try {
            await channel.purgeQueue(queue);
        } catch (error) {
            // Queue might not exist, ignore error
        }
    }

    /**
     * Purges all messages from multiple queues.
     * @param queues Array of queue names to purge
     */
    async purgeAll(queues: string[]): Promise<void> {
        for (const queue of queues) {
            await this.purgeQueue(queue);
        }
    }

    /**
     * Deletes a queue if it exists.
     * @param queue Queue name to delete
     */
    async deleteQueue(queue: string): Promise<void> {
        const channel = await this.ensureChannel();
        try {
            await channel.deleteQueue(queue);
        } catch (error) {
            // Queue might not exist, ignore error
        }
    }

    /**
     * Deletes an exchange if it exists.
     * @param exchange Exchange name to delete
     */
    async deleteExchange(exchange: string): Promise<void> {
        const channel = await this.ensureChannel();
        try {
            await channel.deleteExchange(exchange);
        } catch (error) {
            // Exchange might not exist, ignore error
        }
    }

    /**
     * Peeks at messages in a queue without consuming them.
     * Uses get() to retrieve messages and then requeues them.
     * @param queue Queue name
     * @param count Maximum number of messages to peek
     * @returns Array of messages (may be fewer than count if queue has fewer messages)
     */
    async peekMessages(queue: string, count: number): Promise<any[]> {
        const channel = await this.ensureChannel();
        const messages: any[] = [];

        for (let i = 0; i < count; i++) {
            const msg = await channel.get(queue, { noAck: false });
            if (msg === false) {
                break; // No more messages
            }
            messages.push(msg);
            // Requeue the message
            channel.nack(msg, false, true);
        }

        return messages;
    }

    /**
     * Gets the number of messages currently in a queue.
     * @param queue Queue name
     * @returns Number of messages in the queue
     */
    async getMessageCount(queue: string): Promise<number> {
        const channel = await this.ensureChannel();
        try {
            const queueInfo = await channel.checkQueue(queue);
            return queueInfo.messageCount;
        } catch (error) {
            // Queue doesn't exist
            return 0;
        }
    }

    /**
     * Waits for a queue to have a specific number of messages.
     * Uses polling with exponential backoff.
     * @param queue Queue name
     * @param count Expected number of messages
     * @param timeoutMs Maximum time to wait in milliseconds
     * @throws Error if timeout is reached before condition is met
     */
    async waitForMessages(queue: string, count: number, timeoutMs: number): Promise<void> {
        const startTime = Date.now();
        let attempt = 0;
        const maxDelay = 1000; // Max 1 second between checks

        while (Date.now() - startTime < timeoutMs) {
            const messageCount = await this.getMessageCount(queue);
            
            if (messageCount >= count) {
                return; // Success
            }

            // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms, 1000ms
            const delay = Math.min(50 * Math.pow(2, attempt), maxDelay);
            await new Promise(resolve => setTimeout(resolve, delay));
            attempt++;
        }

        const actualCount = await this.getMessageCount(queue);
        throw new Error(
            `Timeout waiting for ${count} messages in queue '${queue}'. ` +
            `Found ${actualCount} messages after ${timeoutMs}ms`
        );
    }

    /**
     * Waits for a queue to be empty.
     * @param queue Queue name
     * @param timeoutMs Maximum time to wait in milliseconds
     * @throws Error if timeout is reached before queue is empty
     */
    async waitForEmptyQueue(queue: string, timeoutMs: number): Promise<void> {
        const startTime = Date.now();
        let attempt = 0;
        const maxDelay = 1000;

        while (Date.now() - startTime < timeoutMs) {
            const messageCount = await this.getMessageCount(queue);
            
            if (messageCount === 0) {
                return; // Success
            }

            const delay = Math.min(50 * Math.pow(2, attempt), maxDelay);
            await new Promise(resolve => setTimeout(resolve, delay));
            attempt++;
        }

        const actualCount = await this.getMessageCount(queue);
        throw new Error(
            `Timeout waiting for queue '${queue}' to be empty. ` +
            `Still has ${actualCount} messages after ${timeoutMs}ms`
        );
    }

    /**
     * Simulates a connection disconnection by closing the channel.
     * Useful for testing reconnection logic.
     */
    async simulateDisconnection(): Promise<void> {
        if (this.channel) {
            await this.channel.close();
            this.channel = null;
        }
    }

    /**
     * Consumes a single message from a queue.
     * @param queue Queue name
     * @param timeoutMs Maximum time to wait for a message
     * @returns The consumed message or null if timeout
     */
    async consumeOne(queue: string, timeoutMs: number = 5000): Promise<any | null> {
        const channel = await this.ensureChannel();
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve(null);
            }, timeoutMs);

            channel.consume(queue, (msg: any) => {
                clearTimeout(timeout);
                if (msg) {
                    channel.ack(msg);
                    resolve(msg);
                } else {
                    resolve(null);
                }
            }, { noAck: false });
        });
    }

    /**
     * Checks if a queue exists.
     * @param queue Queue name
     * @returns True if queue exists, false otherwise
     */
    async queueExists(queue: string): Promise<boolean> {
        const channel = await this.ensureChannel();
        try {
            await channel.checkQueue(queue);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Checks if an exchange exists.
     * @param exchange Exchange name
     * @returns True if exchange exists, false otherwise
     */
    async exchangeExists(exchange: string): Promise<boolean> {
        const channel = await this.ensureChannel();
        try {
            await channel.checkExchange(exchange);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Closes the helper's channel and connection.
     */
    async close(): Promise<void> {
        if (this.channel) {
            await this.channel.close();
            this.channel = null;
        }
        if (this.connection) {
            await this.connection.close();
            this.connection = null;
        }
    }

    /**
     * Alias for close() method.
     */
    async disconnect(): Promise<void> {
        await this.close();
    }
}
