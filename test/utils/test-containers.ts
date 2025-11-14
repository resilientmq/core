import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq';

/**
 * Manages the lifecycle of Docker containers for integration tests.
 * Provides methods to start, stop, and interact with RabbitMQ containers.
 */
export class TestContainersManager {
    private rabbitMQContainer: StartedRabbitMQContainer | null = null;

    /**
     * Starts a RabbitMQ container with management plugin enabled.
     * @returns The started RabbitMQ container instance
     * @throws Error if container fails to start or become ready
     */
    async startRabbitMQ(): Promise<StartedRabbitMQContainer> {
        try {
            this.rabbitMQContainer = await new RabbitMQContainer('rabbitmq:3.12-management')
                .withExposedPorts(5672, 15672)
                .start();

            await this.waitForReady(30000);
            return this.rabbitMQContainer;
        } catch (error) {
            throw new Error(`Failed to start RabbitMQ container: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Stops and removes all running containers.
     * @throws Error if container fails to stop
     */
    async stopAll(): Promise<void> {
        try {
            if (this.rabbitMQContainer) {
                await this.rabbitMQContainer.stop();
                this.rabbitMQContainer = null;
            }
        } catch (error) {
            throw new Error(`Failed to stop containers: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Gets the AMQP connection URL for the running RabbitMQ container.
     * @returns Connection URL in format: amqp://host:port
     * @throws Error if container is not started
     */
    getConnectionUrl(): string {
        if (!this.rabbitMQContainer) {
            throw new Error('RabbitMQ container not started. Call startRabbitMQ() first.');
        }

        const host = this.rabbitMQContainer.getHost();
        const port = this.rabbitMQContainer.getMappedPort(5672);
        return `amqp://${host}:${port}`;
    }

    /**
     * Waits for RabbitMQ to be ready to accept connections.
     * Uses exponential backoff for connection attempts.
     * @param timeoutMs Maximum time to wait in milliseconds
     * @throws Error if RabbitMQ doesn't become ready within timeout
     */
    async waitForReady(timeoutMs: number): Promise<void> {
        if (!this.rabbitMQContainer) {
            throw new Error('RabbitMQ container not started. Call startRabbitMQ() first.');
        }

        const startTime = Date.now();
        let attempt = 0;
        const maxAttempts = 10;

        while (Date.now() - startTime < timeoutMs) {
            try {
                // Try to connect using amqplib
                const amqp = await import('amqplib');
                const connection = await amqp.connect(this.getConnectionUrl());
                await connection.close();
                return; // Success
            } catch (error) {
                attempt++;
                if (attempt >= maxAttempts) {
                    throw new Error(`RabbitMQ not ready after ${maxAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
                }

                // Exponential backoff: 100ms, 200ms, 400ms, 800ms, etc.
                const delay = Math.min(100 * Math.pow(2, attempt), 2000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw new Error(`RabbitMQ not ready within ${timeoutMs}ms timeout`);
    }
}
