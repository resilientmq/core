import amqplib, {Channel, ChannelModel, Options} from 'amqplib';
import {log} from '../logger/logger';
import {EventMessage, MessageQueue, PublishOptions} from "../types";

/**
 * AMQP-compliant implementation of the MessageQueue interface.
 * Supports connection, publish, consume, and clean disconnect.
 */
export class AmqpQueue implements MessageQueue {
    private _connection!: ChannelModel;
    private _channel!: Channel;
    private _prefetchCount = 1;
    private readonly consumerTags: Map<string, string> = new Map();
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
        this._connection = await amqplib.connect(this.connConfig);
        this._channel = await this._connection.createChannel();
        await this._channel.prefetch(this._prefetchCount);

        this._connection.on('close', () => {
            this.closed = true;
        });
    }

    /**
     * Publishes an event either to a direct queue or an exchange.
     *
     * @param destination - Queue name (used if no exchange).
     * @param event - The event to send.
     * @param options - Optional exchange and AMQP properties.
     */
    async publish(destination: string, event: EventMessage, options?: PublishOptions): Promise<void> {
        const content = Buffer.from(JSON.stringify(event));
        const props = options?.properties ?? {persistent: true};

        if (options?.exchange) {
            const {name, type, routingKey = '', options: exchangeOptions} = options.exchange;
            await this._channel.assertExchange(name, type, exchangeOptions);
            this._channel.publish(name, routingKey, content, props);
        } else {
            await this._channel.assertQueue(destination, {durable: true});
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
        await this._channel.checkQueue(queue);

        const {consumerTag} = await this._channel.consume(queue, async (msg) => {
            if (!msg) return;

            try {
                const event = JSON.parse(msg.content.toString());
                await onMessage(event);

                const socket = (this._channel as any)?.connection?.stream;
                if (socket?.writable) {
                    this._channel.ack(msg);
                } else {
                    log('warn', `[AMQP] Cannot ack: channel stream closed`);
                }
            } catch (err) {
                log('error', `[AMQP] Error processing message`, err);

                try {
                    const socket = (this._channel as any)?.connection?.stream;
                    if (socket?.writable) {
                        this._channel.nack(msg, false, false);
                    } else {
                        log('warn', `[AMQP] Cannot nack: channel stream closed`);
                    }
                } catch (nackErr) {
                    log('error', `[AMQP] Failed to nack message`, nackErr);
                }
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
        if (this._channel) await this._channel.close();
        if (this._connection) await this._connection.close();
    }

    /**
     * Alias for `disconnect()`.
     */
    async close(): Promise<void> {
        await this.disconnect();
    }
}
