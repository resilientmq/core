import amqplib, {
    ChannelModel,
    ConfirmChannel,
    ConsumeMessage,
    Options
} from 'amqplib';
import {randomUUID} from 'crypto';
import {log} from '../logger/logger';
import {
    DeliveryDisposition,
    EventConsumeStatus,
    EventMessage,
    EventProperties,
    MessageQueue,
    MessageQueueDisconnect,
    PublishOptions,
    RawMessageDelivery
} from '../types';

/** AMQP transport with publisher confirms, mandatory routing and raw delivery control. */
export class AmqpQueue implements MessageQueue {
    private _connection?: ChannelModel;
    private _channel?: ConfirmChannel;
    private _prefetchCount = 1;
    private readonly consumerTags = new Map<string, string>();
    private readonly disconnectListeners = new Set<(disconnect: MessageQueueDisconnect) => void>();
    private readonly exchangeAssertions = new Map<string, Promise<void>>();
    private readonly pendingPublications = new Map<string, (error: Error) => void>();
    private drainGate?: Promise<void>;
    private _processingMessages = 0;
    private _pendingAcks = 0;
    private closing = false;
    public closed = true;

    constructor(private readonly connConfig: string | Options.Connect) {}

    /** Active AMQP connection. */
    get connection(): ChannelModel {
        if (!this._connection) throw new Error('[AMQP] Connection is not established');
        return this._connection;
    }

    /** Active confirm channel. */
    get channel(): ConfirmChannel {
        if (!this._channel) throw new Error('[AMQP] Channel is not established');
        return this._channel;
    }

    /** Configured consumer prefetch. */
    get prefetchCount(): number { return this._prefetchCount; }

    /** Number of delivery handlers currently executing. */
    get processingMessages(): number { return this._processingMessages; }

    /** Number of AMQP dispositions currently being written. */
    get pendingAcks(): number { return this._pendingAcks; }

    /** Establishes a heartbeat-protected AMQP connection and confirm channel. */
    async connect(prefetch = 1): Promise<void> {
        if (!Number.isInteger(prefetch) || prefetch < 0) {
            throw new Error('[AMQP] Prefetch must be a non-negative integer');
        }

        this._prefetchCount = prefetch;
        this.closing = false;
        this.exchangeAssertions.clear();
        this.drainGate = undefined;

        try {
            const connection = await amqplib.connect(this.withDefaultHeartbeat(this.connConfig));
            this._connection = connection;
            connection.on('close', () => this.handleDisconnect('connection'));
            connection.on('error', (error: Error) => this.handleDisconnect('connection', error));

            const channel = await connection.createConfirmChannel();
            this._channel = channel;
            channel.on('return', (message: ConsumeMessage) => this.handleReturnedMessage(message));
            channel.on('close', () => this.handleDisconnect('channel'));
            channel.on('error', (error: Error) => this.handleDisconnect('channel', error));

            await channel.prefetch(prefetch);
            this.closed = false;
            log('debug', '[AMQP] Confirm channel established');
        } catch (error) {
            this.closed = true;
            await this.closeResources(true);
            log('error', '[AMQP] Failed to connect', error);
            throw error;
        }
    }

    /** Publishes an event and resolves only after RabbitMQ confirms it. */
    async publish(destination: string, event: EventMessage, options?: PublishOptions): Promise<void> {
        const headers = event.properties?.headers ?? {};
        await this.publishRaw(
            destination,
            Buffer.from(JSON.stringify(event.payload)),
            {
                ...event.properties,
                messageId: event.messageId,
                type: event.type,
                headers: {
                    ...headers,
                    'x-message-id': event.messageId,
                    'x-event-type': event.type
                }
            },
            event.routingKey === undefined ? options : {...options, routingKey: event.routingKey}
        );
    }

    /** Publishes an unmodified body with mandatory routing and a publisher confirm. */
    async publishRaw(
        destination: string,
        content: Buffer,
        properties: EventProperties = {},
        options?: PublishOptions
    ): Promise<void> {
        if (this.closed || !this._channel) {
            throw new Error('[AMQP] Cannot publish while the channel is closed');
        }

        const channel = this._channel;
        const publicationId = randomUUID();
        const headers = {
            ...(properties.headers ?? {}),
            'x-resilientmq-publication-id': publicationId
        };
        const publishProperties: Options.Publish = {
            ...properties,
            headers,
            deliveryMode: properties.deliveryMode ?? 2,
            mandatory: true
        };

        if (options?.exchange) {
            await this.assertExchange(options.exchange);
        }

        const confirmTimeoutMs = options?.confirmTimeoutMs ?? 10000;
        if (!Number.isFinite(confirmTimeoutMs) || confirmTimeoutMs <= 0) {
            throw new Error('[AMQP] Publisher confirm timeout must be positive');
        }
        if (this.drainGate) await this.drainGate;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let rejectPublication: ((error: Error) => void) | undefined;

        let drained = Promise.resolve();
        const confirmed = new Promise<void>((resolve, reject) => {
            let settled = false;
            const settle = (error?: Error) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                this.pendingPublications.delete(publicationId);
                if (error) reject(error); else resolve();
            };

            rejectPublication = (error: Error) => settle(error);
            this.pendingPublications.set(publicationId, rejectPublication);
            timeout = setTimeout(
                () => settle(new Error(`[AMQP] Publisher confirm timed out after ${confirmTimeoutMs}ms`)),
                confirmTimeoutMs
            );

            const callback = (error: unknown) => {
                if (error instanceof Error) settle(error);
                else if (error) settle(new Error(String(error)));
                else settle();
            };

            try {
                const writable = options?.exchange
                    ? channel.publish(
                        options.exchange.name,
                        options.routingKey ?? '',
                        content,
                        publishProperties,
                        callback
                    )
                    : channel.sendToQueue(destination, content, publishProperties, callback);

                if (!writable) {
                    const drain = this.waitForDrain(channel, confirmTimeoutMs);
                    let gate!: Promise<void>;
                    gate = drain.finally(() => {
                        if (this.drainGate === gate) this.drainGate = undefined;
                    });
                    this.drainGate = gate;
                    drained = gate;
                }
            } catch (error) {
                settle(error instanceof Error ? error : new Error(String(error)));
            }
        });

        try {
            await Promise.all([confirmed, drained]);
        } catch (error) {
            rejectPublication?.(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /** Consumes JSON events while retaining the legacy handler contract. */
    async consume(queue: string, onMessage: (event: EventMessage) => Promise<void>): Promise<void> {
        await this.consumeRaw(queue, async (delivery) => {
            try {
                const payload = JSON.parse(delivery.content.toString());
                const messageId = delivery.properties.messageId
                    ?? String(delivery.properties.headers?.['x-message-id'] ?? '');
                const type = delivery.properties.type
                    ?? String(delivery.properties.headers?.['x-event-type'] ?? '');
                await onMessage({
                    messageId,
                    type,
                    payload,
                    status: EventConsumeStatus.RECEIVED,
                    properties: delivery.properties,
                    routingKey: delivery.routingKey || undefined
                });
                return 'ack';
            } catch {
                return 'reject';
            }
        });
    }

    /** Consumes raw messages and applies an explicit disposition. */
    async consumeRaw(
        queue: string,
        onMessage: (delivery: RawMessageDelivery) => Promise<DeliveryDisposition>
    ): Promise<void> {
        const channel = this.channel;
        const {consumerTag} = await channel.consume(queue, async (message) => {
            if (!message) return;

            this._processingMessages++;
            let disposition: DeliveryDisposition = 'requeue';
            try {
                disposition = await onMessage({
                    content: message.content,
                    properties: message.properties,
                    exchange: message.fields.exchange,
                    routingKey: message.fields.routingKey,
                    redelivered: message.fields.redelivered
                });
            } catch (error) {
                log('error', '[AMQP] Raw delivery handler failed', error);
            } finally {
                this._processingMessages--;
            }

            this._pendingAcks++;
            try {
                if (disposition === 'ack') channel.ack(message);
                else channel.nack(message, false, disposition === 'requeue');
            } catch (error) {
                log('warn', '[AMQP] Delivery disposition could not be written', error);
            } finally {
                this._pendingAcks--;
            }
        });

        this.consumerTags.set(queue, consumerTag);
    }

    /** Registers a transport failure listener. */
    onDisconnect(listener: (disconnect: MessageQueueDisconnect) => void): () => void {
        this.disconnectListeners.add(listener);
        return () => this.disconnectListeners.delete(listener);
    }

    /** Cancels every active consumer before shutdown or recovery. */
    async cancelAllConsumers(): Promise<void> {
        const channel = this._channel;
        if (!channel) return;

        const tags = Array.from(this.consumerTags.values());
        this.consumerTags.clear();
        await Promise.all(tags.map(async (tag) => {
            try {
                await channel.cancel(tag);
            } catch (error) {
                log('warn', `[AMQP] Failed to cancel consumer ${tag}`, error);
            }
        }));
    }

    /** Waits for in-flight delivery handlers up to a bounded timeout. */
    async waitForProcessing(timeoutMs = 10000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (this._processingMessages > 0 || this._pendingAcks > 0) {
            if (Date.now() >= deadline) return false;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return true;
    }

    /** Cancels consumers, drains bounded work and closes all AMQP resources. */
    async disconnect(timeoutMs = 10000): Promise<void> {
        this.closing = true;
        await this.cancelAllConsumers();
        await this.waitForProcessing(timeoutMs);
        await this.closeResources(false, timeoutMs);
        this.closed = true;
        this.closing = false;
    }

    /** Alias for disconnect. */
    async close(): Promise<void> { await this.disconnect(); }

    /** Immediately closes AMQP resources so RabbitMQ can redeliver unacked work. */
    async forceClose(): Promise<void> {
        this.closing = true;
        this.closed = true;
        const reason = new Error('[AMQP] Transport force-closed before publication completed');
        for (const reject of this.pendingPublications.values()) reject(reason);
        this.pendingPublications.clear();
        await this.closeResources(true);
        this.closing = false;
    }

    private async assertExchange(exchange: NonNullable<PublishOptions['exchange']>): Promise<void> {
        const key = `${exchange.name}:${exchange.type}:${JSON.stringify(exchange.options ?? {})}`;
        let assertion = this.exchangeAssertions.get(key);
        if (!assertion) {
            assertion = this.channel.assertExchange(exchange.name, exchange.type, exchange.options).then(() => undefined);
            this.exchangeAssertions.set(key, assertion);
        }

        try {
            await assertion;
        } catch (error) {
            this.exchangeAssertions.delete(key);
            throw error;
        }
    }

    private handleReturnedMessage(message: ConsumeMessage): void {
        const publicationId = message.properties.headers?.['x-resilientmq-publication-id'];
        if (typeof publicationId !== 'string') return;
        this.pendingPublications.get(publicationId)?.(
            new Error(`[AMQP] Message ${message.properties.messageId ?? publicationId} was returned as unroutable`)
        );
    }

    private async waitForDrain(channel: ConfirmChannel, timeoutMs: number): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(
                () => finish(new Error(`[AMQP] Channel drain timed out after ${timeoutMs}ms`)),
                timeoutMs
            );
            const onDrain = () => finish();
            const onClose = () => finish(new Error('[AMQP] Channel closed while waiting for drain'));
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                channel.removeListener('drain', onDrain);
                channel.removeListener('close', onClose);
                if (error) reject(error); else resolve();
            };
            channel.once('drain', onDrain);
            channel.once('close', onClose);
        });
    }

    private handleDisconnect(source: MessageQueueDisconnect['source'], error?: Error): void {
        if (this.closed && !error) return;
        this.closed = true;
        const reason = error ?? new Error(`[AMQP] ${source} closed before publication completed`);
        for (const reject of this.pendingPublications.values()) reject(reason);
        this.pendingPublications.clear();
        if (!this.closing) {
            for (const listener of this.disconnectListeners) listener({source, error});
        }
        log(error ? 'error' : 'debug', `[AMQP] ${source} unavailable`, error);
    }

    private async closeResources(force = false, timeoutMs = 10000): Promise<void> {
        const channel = this._channel;
        const connection = this._connection;
        this._channel = undefined;
        this._connection = undefined;
        this.exchangeAssertions.clear();
        this.drainGate = undefined;

        if (force && this.destroyConnection(connection)) return;

        const gracefulClose = (async () => {
            try {
                if (channel) await channel.close();
            } catch (error) {
                log('warn', '[AMQP] Confirm channel close failed', error);
            }
            try {
                if (connection) await connection.close();
            } catch (error) {
                log('warn', '[AMQP] Connection close failed', error);
            }
        })();

        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
            gracefulClose.then(() => false),
            new Promise<boolean>(resolve => {
                timeout = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
            })
        ]);
        if (timeout) clearTimeout(timeout);
        if (timedOut) this.destroyConnection(connection);
    }

    private destroyConnection(connection: ChannelModel | undefined): boolean {
        const stream = (connection?.connection as {stream?: {destroy(error?: Error): void}} | undefined)?.stream;
        if (!stream) return false;
        stream.destroy();
        return true;
    }

    private withDefaultHeartbeat(config: string | Options.Connect): string | Options.Connect {
        if (typeof config !== 'string') {
            return {...config, heartbeat: config.heartbeat ?? 10};
        }

        try {
            const url = new URL(config);
            if (!url.searchParams.has('heartbeat')) url.searchParams.set('heartbeat', '10');
            return url.toString();
        } catch {
            return config;
        }
    }
}
