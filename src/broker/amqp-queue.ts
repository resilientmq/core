import amqplib, {Channel, ChannelModel, Options} from 'amqplib';
import {log} from '../logger/logger';
import {EventConsumeStatus, EventMessage, MessageQueue, PublishOptions} from "../types";

/**
 * AMQP-compliant implementation of the MessageQueue interface.
 * Supports connection, publish, consume, and clean disconnect.
 */
export class AmqpQueue implements MessageQueue {
    private _connection!: ChannelModel;
    private _channel!: Channel;
    private _prefetchCount = 1;
    private readonly consumerTags: Map<string, string> = new Map();
    private processingMessages = 0;
    public closed = false;

    constructor(private readonly connConfig: string | Options.Connect) {
    }

    /** Returns the current AMQP connection. */
    get connection(): ChannelModel {
        return this._connection;
    }

    /** Returns the current AMQP channel. */
    get channel(): Channel {
        return this._channel;
    }

    /** Returns the current prefetch count. */
    get prefetchCount(): number {
        return this._prefetchCount;
    }

    /**
     * Connects to the AMQP broker and prepares the channel.
     *
     * @param prefetch - Max number of unacknowledged messages.
     */
    async connect(prefetch: number = 1): Promise<void> {
        this._prefetchCount = prefetch;
        
        try {
            this._connection = await amqplib.connect(this.connConfig);
            
            // Setup connection event handlers immediately after connection
            this._connection.on('close', () => {
                this.closed = true;
                log('debug', '[AMQP] Connection closed');
            });

            this._connection.on('error', (err) => {
                this.closed = true;
                log('error', '[AMQP] Connection error', err);
            });

            // Remove default error handler to prevent unhandled errors
            this._connection.removeAllListeners('error');
            this._connection.on('error', (err) => {
                this.closed = true;
                log('error', '[AMQP] Connection error', err);
            });

            this._channel = await this._connection.createChannel();
            
            // Setup channel event handlers immediately after channel creation
            this._channel.on('close', () => {
                log('debug', '[AMQP] Channel closed');
            });

            this._channel.on('error', (err) => {
                log('error', '[AMQP] Channel error', err);
            });

            await this._channel.prefetch(this._prefetchCount);
        } catch (error) {
            this.closed = true;
            log('error', '[AMQP] Failed to connect', error);
            throw error;
        }
    }

    /**
     * Publishes an event either to a direct queue or an exchange.
     *
     * @param destination - Queue name (used if no exchange).
     * @param event - The event to send.
     * @param options - Optional exchange and AMQP properties.
     */
    async publish(destination: string, event: EventMessage, options?: PublishOptions): Promise<void> {
        const content = Buffer.from(JSON.stringify(event.payload));
        
        // Merge event properties with messageId and type
        // Note: AMQP uses message_id (snake_case), but amqplib accepts messageId (camelCase)
        const props = {
            ...(event.properties ?? {}),
            messageId: event.messageId,
            type: event.type,
            persistent: event.properties?.deliveryMode === 2 || true,
            // Also add to headers for reliability
            headers: {
                ...(event.properties?.headers ?? {}),
                'x-message-id': event.messageId,
                'x-event-type': event.type
            }
        };

        if (options?.exchange) {
            const {name, type, options: exchangeOptions} = options.exchange;
            await this._channel.assertExchange(name, type, exchangeOptions);
            // Use routingKey from the event when provided; otherwise use empty string (no routing key)
            const routingKey = event.routingKey ?? '';
            this._channel.publish(name, routingKey, content, props);
        } else {
            // Don't assert queue here - let the consumer create it with proper DLX configuration
            // Just send to the queue (it should already exist)
            this._channel.sendToQueue(destination, content, props);
        }
    }

    /**
     * Subscribes to a queue and processes incoming messages.
     *
     * @param queue - The queue to consume from.
     * @param onMessage - Function to handle each message.
     */
    async consume(queue: string, onMessage: (event: EventMessage) => Promise<void>): Promise<void> {
        // Don't check queue here - it should already be asserted by the consumer setup
        // await this._channel.checkQueue(queue);

        const {consumerTag} = await this._channel.consume(queue, async (msg) => {
            if (!msg) return;

            this.processingMessages++;

            try {
                const payload = JSON.parse(msg.content.toString());
                // Try to get messageId from properties first, then from headers
                const messageId = msg.properties.messageId || msg.properties.headers?.['x-message-id'];
                const type = msg.properties.type || msg.properties.headers?.['x-event-type'];
                

                await onMessage({
                    messageId,
                    type,
                    payload,
                    status: EventConsumeStatus.RECEIVED,
                    properties: msg.properties,
                });

                const socket = (this._channel as any)?.connection?.stream;
                if (socket?.writable) {
                    this._channel.ack(msg);
                    log('debug', `[AMQP] Message acknowledged`);
                } else {
                    log('warn', `[AMQP] Cannot ack: channel closed`);
                }
            } catch (err) {
                log('debug', `[AMQP] Message processing failed, sending nack`);
                try {
                    const socket = (this._channel as any)?.connection?.stream;
                    if (socket?.writable) {
                        // Nack without requeue - this triggers DLX routing to retry queue
                        this._channel.nack(msg, false, false);
                        log('debug', `[AMQP] Message nacked (will be routed to DLX)`);
                    } else {
                        log('warn', `[AMQP] Cannot nack: channel closed`);
                    }
                } catch (nackErr) {
                    log('error', `[AMQP] Failed to nack message`, nackErr);
                }
            } finally {
                this.processingMessages--;
            }
        });

        this.consumerTags.set(queue, consumerTag);
    }

    /**
     * Cancels all consumer subscriptions on this channel.
     */
    async cancelAllConsumers(): Promise<void> {
        for (const tag of this.consumerTags.values()) {
            try {
                await this._channel.cancel(tag);
            } catch (err) {
                log('warn', `[AMQP] Failed to cancel consumer tag ${tag}`, err);
            }
        }
        this.consumerTags.clear();
    }

    /**
     * Gracefully closes the channel and connection.
     */
    async disconnect(): Promise<void> {
        if (this.closed) {
            return;
        }

        await this.cancelAllConsumers();

        const waitForProcessing = async () => {
            while (this.processingMessages > 0) {
                await new Promise(resolve => setTimeout(resolve, 100)); // check each 100ms
            }
        };

        await waitForProcessing();

        try {
            if (this._channel) {
                await this._channel.close();
            }
        } catch (err) {
            log('warn', '[AMQP] Error closing channel', err);
        }

        try {
            if (this._connection) {
                await this._connection.close();
            }
        } catch (err) {
            log('warn', '[AMQP] Error closing connection', err);
        }

        this.closed = true;
    }


    /**
     * Alias for `disconnect()`.
     */
    async close(): Promise<void> {
        await this.disconnect();
    }
}
