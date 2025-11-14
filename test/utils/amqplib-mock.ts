import { Options, ConsumeMessage } from 'amqplib';

/**
 * Mock implementation of amqplib for unit testing.
 * Simulates RabbitMQ behavior without requiring a real broker.
 */
export class AMQPLibMock {
    private shouldFailConnection: boolean = false;
    private shouldFailChannel: boolean = false;
    private connections: MockConnection[] = [];

    /**
     * Creates a mock AMQP connection.
     * @param url Connection URL (ignored in mock)
     * @returns Mock connection instance
     */
    async connect(url: string | Options.Connect): Promise<MockConnection> {
        if (this.shouldFailConnection) {
            throw new Error('Connection failed (simulated)');
        }

        const connection = new MockConnection(this);
        this.connections.push(connection);
        return connection;
    }

    /**
     * Simulates connection failures.
     * @param fail If true, connect() will throw an error
     */
    setConnectionFailure(fail: boolean): void {
        this.shouldFailConnection = fail;
    }

    /**
     * Simulates channel creation failures.
     * @param fail If true, createChannel() will throw an error
     */
    setChannelFailure(fail: boolean): void {
        this.shouldFailChannel = fail;
    }

    /**
     * Gets all published messages for a specific queue.
     * @param queue Queue name
     * @returns Array of messages published to the queue
     */
    getPublishedMessages(queue: string): ConsumeMessage[] {
        const messages: ConsumeMessage[] = [];
        for (const conn of this.connections) {
            messages.push(...conn.getPublishedMessages(queue));
        }
        return messages;
    }

    /**
     * Clears all connections and their state.
     */
    reset(): void {
        this.connections = [];
        this.shouldFailConnection = false;
        this.shouldFailChannel = false;
    }

    getShouldFailChannel(): boolean {
        return this.shouldFailChannel;
    }
}

/**
 * Mock AMQP connection.
 */
export class MockConnection {
    private channels: MockChannel[] = [];
    private eventHandlers: Map<string, Function[]> = new Map();
    private closed: boolean = false;
    private mock: AMQPLibMock;

    constructor(mock: AMQPLibMock) {
        this.mock = mock;
    }

    async createChannel(): Promise<MockChannel> {
        if (this.mock.getShouldFailChannel()) {
            throw new Error('Channel creation failed (simulated)');
        }

        if (this.closed) {
            throw new Error('Connection is closed');
        }

        const channel = new MockChannel();
        this.channels.push(channel);
        return channel;
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const channel of this.channels) {
            await channel.close();
        }
        this.emit('close');
    }

    on(event: string, handler: Function): this {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event)!.push(handler);
        return this;
    }

    removeAllListeners(event?: string): this {
        if (event) {
            this.eventHandlers.delete(event);
        } else {
            this.eventHandlers.clear();
        }
        return this;
    }

    emit(event: string, ...args: any[]): void {
        const handlers = this.eventHandlers.get(event) || [];
        for (const handler of handlers) {
            handler(...args);
        }
    }

    getPublishedMessages(queue: string): ConsumeMessage[] {
        const messages: ConsumeMessage[] = [];
        for (const channel of this.channels) {
            messages.push(...channel.getPublishedMessages(queue));
        }
        return messages;
    }

    simulateError(error: Error): void {
        this.emit('error', error);
    }

    isClosed(): boolean {
        return this.closed;
    }
}

/**
 * Mock AMQP channel.
 */
export class MockChannel {
    private queues: Map<string, MockQueue> = new Map();
    private exchanges: Map<string, MockExchange> = new Map();
    private bindings: Map<string, Set<string>> = new Map(); // queue -> set of exchange:routingKey
    private consumers: Map<string, Function> = new Map();
    private eventHandlers: Map<string, Function[]> = new Map();
    private closed: boolean = false;

    async assertQueue(queue: string, options?: Options.AssertQueue): Promise<any> {
        if (this.closed) {
            throw new Error('Channel is closed');
        }

        if (!this.queues.has(queue)) {
            this.queues.set(queue, new MockQueue());
        }

        return {
            queue,
            messageCount: this.queues.get(queue)!.getMessageCount(),
            consumerCount: 0
        };
    }

    async checkQueue(queue: string): Promise<any> {
        if (this.closed) {
            throw new Error('Channel is closed');
        }

        // Create queue if it doesn't exist (like assertQueue)
        if (!this.queues.has(queue)) {
            this.queues.set(queue, new MockQueue());
        }

        return {
            queue,
            messageCount: this.queues.get(queue)!.getMessageCount(),
            consumerCount: 0
        };
    }

    async assertExchange(exchange: string, type: string, options?: Options.AssertExchange): Promise<any> {
        if (this.closed) {
            throw new Error('Channel is closed');
        }

        if (!this.exchanges.has(exchange)) {
            this.exchanges.set(exchange, new MockExchange(exchange, type, options));
        }

        return { exchange };
    }

    async bindQueue(queue: string, exchange: string, routingKey: string = ''): Promise<any> {
        if (this.closed) {
            throw new Error('Channel is closed');
        }

        const bindingKey = `${queue}`;
        if (!this.bindings.has(bindingKey)) {
            this.bindings.set(bindingKey, new Set());
        }
        this.bindings.get(bindingKey)!.add(`${exchange}:${routingKey}`);

        return {};
    }

    publish(exchange: string, routingKey: string, content: Buffer, options?: Options.Publish): boolean {
        if (this.closed) {
            throw new Error('Channel is closed');
        }

        const message = this.createMessage(content, options);

        // Find queues bound to this exchange with matching routing key
        for (const [queue, bindingSet] of this.bindings.entries()) {
            for (const binding of bindingSet) {
                const [boundExchange, boundRoutingKey] = binding.split(':');
                if (boundExchange === exchange && this.matchesRoutingKey(routingKey, boundRoutingKey)) {
                    this.queues.get(queue)?.addMessage(message);
                }
            }
        }

        return true;
    }

    sendToQueue(queue: string, content: Buffer, options?: Options.Publish): boolean {
        if (this.closed) {
            throw new Error('Channel is closed');
        }

        const message = this.createMessage(content, options);
        
        if (!this.queues.has(queue)) {
            this.assertQueue(queue);
        }

        this.queues.get(queue)!.addMessage(message);
        
        // Trigger consumer if one exists
        const consumer = this.consumers.get(queue);
        if (consumer) {
            setImmediate(() => consumer(message));
        }

        return true;
    }

    async consume(queue: string, onMessage: (msg: ConsumeMessage | null) => void, options?: Options.Consume): Promise<any> {
        if (this.closed) {
            throw new Error('Channel is closed');
        }

        // Ensure queue exists
        if (!this.queues.has(queue)) {
            this.queues.set(queue, new MockQueue());
        }

        this.consumers.set(queue, onMessage);

        // Deliver existing messages
        const queueObj = this.queues.get(queue);
        if (queueObj) {
            const messages = queueObj.getMessages();
            for (const message of messages) {
                setImmediate(() => onMessage(message));
            }
        }

        return { consumerTag: `consumer-${queue}` };
    }

    async cancel(consumerTag: string): Promise<void> {
        // In mock, we don't need to track consumer tags
    }

    ack(message: ConsumeMessage, allUpTo?: boolean): void {
        // In mock, we don't need to track acks
    }

    nack(message: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void {
        if (requeue && message.fields.routingKey) {
            const queue = message.fields.routingKey;
            this.queues.get(queue)?.addMessage(message);
        }
    }

    async prefetch(count: number): Promise<void> {
        // In mock, we don't need to track prefetch
    }

    async close(): Promise<void> {
        this.closed = true;
        this.emit('close');
    }

    on(event: string, handler: Function): this {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event)!.push(handler);
        return this;
    }

    emit(event: string, ...args: any[]): void {
        const handlers = this.eventHandlers.get(event) || [];
        for (const handler of handlers) {
            handler(...args);
        }
    }

    getPublishedMessages(queue: string): ConsumeMessage[] {
        return this.queues.get(queue)?.getMessages() || [];
    }

    simulateIncomingMessage(queue: string, content: any, properties?: any): void {
        const message = this.createMessage(
            Buffer.from(JSON.stringify(content)),
            properties
        );

        if (!this.queues.has(queue)) {
            this.assertQueue(queue);
        }

        this.queues.get(queue)!.addMessage(message);

        const consumer = this.consumers.get(queue);
        if (consumer) {
            setImmediate(() => consumer(message));
        }
    }

    private createMessage(content: Buffer, options?: any): ConsumeMessage {
        return {
            content,
            fields: {
                deliveryTag: Math.random(),
                redelivered: false,
                exchange: '',
                routingKey: '',
                consumerTag: 'mock-consumer'
            },
            properties: {
                contentType: options?.contentType,
                contentEncoding: options?.contentEncoding,
                headers: options?.headers || {},
                deliveryMode: options?.persistent ? 2 : 1,
                priority: options?.priority,
                correlationId: options?.correlationId,
                replyTo: options?.replyTo,
                expiration: options?.expiration,
                messageId: options?.messageId || `msg-${Date.now()}-${Math.random()}`,
                timestamp: options?.timestamp,
                type: options?.type,
                userId: options?.userId,
                appId: options?.appId,
                clusterId: ''
            }
        };
    }

    private matchesRoutingKey(messageKey: string, bindingKey: string): boolean {
        // Simple matching - exact match or empty binding key (fanout-like)
        if (bindingKey === '' || bindingKey === '#') {
            return true;
        }

        // Topic exchange pattern matching (simplified)
        const bindingParts = bindingKey.split('.');
        const messageParts = messageKey.split('.');

        if (bindingParts.length !== messageParts.length && !bindingKey.includes('#')) {
            return false;
        }

        for (let i = 0; i < bindingParts.length; i++) {
            if (bindingParts[i] === '#') {
                return true;
            }
            if (bindingParts[i] !== '*' && bindingParts[i] !== messageParts[i]) {
                return false;
            }
        }

        return true;
    }
}

/**
 * Mock queue storage.
 */
class MockQueue {
    private messages: ConsumeMessage[] = [];

    addMessage(message: ConsumeMessage): void {
        this.messages.push(message);
    }

    getMessages(): ConsumeMessage[] {
        return [...this.messages];
    }

    getMessageCount(): number {
        return this.messages.length;
    }

    clear(): void {
        this.messages = [];
    }
}

/**
 * Mock exchange storage.
 */
class MockExchange {
    private name: string;
    private type: string;

    constructor(name: string, type: string, _options?: Options.AssertExchange) {
        this.name = name;
        this.type = type;
    }

    getName(): string {
        return this.name;
    }

    getType(): string {
        return this.type;
    }
}
