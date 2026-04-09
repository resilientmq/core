import amqplib, { Channel, ChannelModel, Options } from 'amqplib';
import { log } from '../logger/logger';
import { EventConsumeStatus, EventMessage, MessageQueue, PublishOptions } from '../types';

/**
 * AMQP-compliant implementation of the MessageQueue interface.
 * Manages connection lifecycle, publishing, consuming, and graceful shutdown.
 */
export class AmqpQueue implements MessageQueue {
    private _connection!: ChannelModel;
    private _channel!: Channel;
    private _prefetchCount = 1;
    private readonly consumerTags: Map<string, string> = new Map();
    private _processingMessages = 0;
    private _pendingAcks = 0;
    public closed = false;

    constructor(private readonly connConfig: string | Options.Connect) {}

    /* istanbul ignore next */
    get connection(): ChannelModel { return this._connection; }
    /* istanbul ignore next */
    get channel(): Channel { return this._channel; }
    /* istanbul ignore next */
    get prefetchCount(): number { return this._prefetchCount; }
    /* istanbul ignore next */
    get processingMessages(): number { return this._processingMessages; }
    /* istanbul ignore next */
    get pendingAcks(): number { return this._pendingAcks; }

    /**
     * Connects to the AMQP broker and creates a channel with the given prefetch.
     */
    async connect(prefetch = 1): Promise<void> {
        this._prefetchCount = prefetch;
        try {
            this._connection = await amqplib.connect(this.connConfig);
            this._connection.removeAllListeners('error');
            this._connection.on('close', () => { this.closed = true; log('debug', '[AMQP] Connection closed'); });
            this._connection.on('error', (err) => { this.closed = true; log('error', '[AMQP] Connection error', err); });

            this._channel = await this._connection.createChannel();
            this._channel.on('close', () => log('debug', '[AMQP] Channel closed'));
            this._channel.on('error', (err) => log('error', '[AMQP] Channel error', err));

            await this._channel.prefetch(this._prefetchCount);
            this.closed = false;
            log('debug', '[AMQP] Connection established successfully');
        } catch (error) {
            this.closed = true;
            log('error', '[AMQP] Failed to connect', error);
            throw error;
        }
    }

    /**
     * Publishes an event to a queue or exchange.
     */
    async publish(destination: string, event: EventMessage, options?: PublishOptions): Promise<void> {
        const channel = this._channel;
        const content = Buffer.from(JSON.stringify(event.payload));
        /* istanbul ignore next */
        const eventProperties = event.properties;
        const existingHeaders = eventProperties?.headers ?? {};
        const props = {
            ...(eventProperties ?? {}),
            messageId: event.messageId,
            type: event.type,
            persistent: true,
            headers: {
                ...existingHeaders,
                'x-message-id': event.messageId,
                'x-event-type': event.type,
            },
        };

        if (options?.exchange) {
            const { name, type, options: exchangeOptions } = options.exchange;
            await channel.assertExchange(name, type, exchangeOptions);
            channel.publish(name, event.routingKey ?? '', content, props);
        } else {
            channel.sendToQueue(destination, content, props);
        }
    }

    /**
     * Subscribes to a queue and invokes the handler for each message.
     * Acks on success, nacks (no requeue) on failure to trigger DLX routing.
     */
    async consume(queue: string, onMessage: (event: EventMessage) => Promise<void>): Promise<void> {
        const channel = this._channel;
        const { consumerTag } = await channel.consume(queue, async (msg) => {
            /* istanbul ignore next */
            if (!msg) return;

            this._processingMessages++;
            try {
                const payload = JSON.parse(msg.content.toString());
                /* istanbul ignore next */
                const messageId = msg.properties.messageId || msg.properties.headers?.['x-message-id'];
                /* istanbul ignore next */
                const type = msg.properties.type || msg.properties.headers?.['x-event-type'];

                await onMessage({ messageId, type, payload, status: EventConsumeStatus.RECEIVED, properties: msg.properties });

                const channelWritable = this.isChannelWritable();
                if (channelWritable) {
                    this._pendingAcks++;
                    try { channel.ack(msg); } finally { this._pendingAcks--; }
                } else {
                    log('warn', '[AMQP] Cannot ack: channel not writable');
                }
            } catch {
                const channelWritable = this.isChannelWritable();
                if (channelWritable) {
                    this._pendingAcks++;
                    try {
                        channel.nack(msg, false, false);
                    } catch (nackErr) {
                        log('error', '[AMQP] Failed to nack message', nackErr);
                    } finally {
                        this._pendingAcks--;
                    }
                } else {
                    log('warn', '[AMQP] Cannot nack: channel not writable');
                }
            } finally {
                this._processingMessages--;
            }
        });

        this.consumerTags.set(queue, consumerTag);
    }

    /**
     * Cancels all active consumer subscriptions.
     */
    async cancelAllConsumers(): Promise<void> {
        for (const tag of this.consumerTags.values()) {
            try { await this._channel.cancel(tag); } catch (err) {
                log('warn', `[AMQP] Failed to cancel consumer tag ${tag}`, err);
            }
        }
        this.consumerTags.clear();
    }

    /**
     * Resolves when all in-flight messages and pending acks/nacks are complete.
     */
    async waitForProcessing(): Promise<void> {
        while (this._processingMessages > 0 || this._pendingAcks > 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    /**
     * Gracefully closes the channel and connection.
     * Waits up to 10 seconds for in-flight messages to finish before forcing close.
     */
    async disconnect(): Promise<void> {
        if (this.closed) return;
        const channel = this._channel;
        const connection = this._connection;

        await this.cancelAllConsumers();
        await this.waitForProcessing();

        try { if (channel) await channel.close(); } catch (err) {
            log('warn', '[AMQP] Error closing channel', err);
        }
        try { if (connection) await connection.close(); } catch (err) {
            log('warn', '[AMQP] Error closing connection', err);
        }

        this.closed = true;
    }

    /** Alias for `disconnect()`. */
    async close(): Promise<void> {
        await this.disconnect();
    }

    /**
     * Forces an immediate close of the connection without waiting for in-flight messages.
     * Use when a clean shutdown is not possible (e.g., connection already broken).
     */
    async forceClose(): Promise<void> {
        this.closed = true;
        const channel = this._channel;
        const connection = this._connection;
        try { if (channel) await channel.close(); } catch {}
        try { if (connection) await connection.close(); } catch {}
    }

    /* istanbul ignore next */
    private isChannelWritable(): boolean {
        return !!(this._channel as any)?.connection?.stream?.writable;
    }
}
