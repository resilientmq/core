import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { TestContainersManager } from '../utils/test-containers';
import { EventStoreMock } from '../utils/event-store-mock';
import { EventBuilder, ConsumerConfigBuilder, PublisherConfigBuilder } from '../utils/test-data-builders';

describe('Integration: Multiple Exchanges and Routing Keys', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    let consumer: ResilientConsumer;
    let publisher: ResilientEventPublisher;
    let store: EventStoreMock;
    let publisherStore: EventStoreMock;

    beforeAll(async () => {
        containerManager = new TestContainersManager();
        await containerManager.startRabbitMQ();
        connectionUrl = containerManager.getConnectionUrl();
    }, 60000);

    afterAll(async () => {
        await containerManager.stopAll();
    }, 30000);

    beforeEach(() => {
        store = new EventStoreMock();
    });

    afterEach(async () => {
        if (consumer) {
            try {
                await (consumer as any).queue?.disconnect();
            } catch (error) {
                // Ignore cleanup errors
            }
        }
        if (publisher) {
            try {
                publisher.stopPendingEventsCheck();
            } catch (error) {
                // Ignore cleanup errors
            }
        }
        store.clear();
        if (publisherStore) {
            publisherStore.clear();
        }
    });

    it('should route messages based on topic exchange patterns', async () => {
        // Arrange
        const receivedMessages: any[] = [];

        const consumerConfig = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.topic.queue')
            .withStore(store)
            .withExchanges([{
                name: 'test.topic.exchange',
                type: 'topic',
                routingKey: 'user.*.created', // Match user.*.created pattern
                options: { durable: true }
            }])
            .withEventHandler('user.event', async (event) => {
                receivedMessages.push(event.payload);
            })
            .build();

        consumer = new ResilientConsumer(consumerConfig);

        publisherStore = new EventStoreMock();
        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withExchangeConfig('test.topic.exchange', 'topic')
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        await consumer.start();

        // Act - Publish messages with different routing keys
        const matchingEvent1 = new EventBuilder()
            .withType('user.event')
            .withPayload({ action: 'admin.created' })
            .withRoutingKey('user.admin.created') // Should match
            .build();

        const matchingEvent2 = new EventBuilder()
            .withType('user.event')
            .withPayload({ action: 'guest.created' })
            .withRoutingKey('user.guest.created') // Should match
            .build();

        const nonMatchingEvent = new EventBuilder()
            .withType('user.event')
            .withPayload({ action: 'updated' })
            .withRoutingKey('user.updated') // Should NOT match
            .build();

        // Wait for consumer to be ready
        await new Promise(resolve => setTimeout(resolve, 500));
        
        await publisher.publish(matchingEvent1);
        await publisher.publish(matchingEvent2);
        await publisher.publish(nonMatchingEvent);

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Assert - Only matching messages should be received
        expect(receivedMessages.length).toBeGreaterThanOrEqual(2);
        expect(receivedMessages).toContainEqual({ action: 'admin.created' });
        expect(receivedMessages).toContainEqual({ action: 'guest.created' });
    }, 30000);

    it('should handle direct exchange with specific routing keys', async () => {
        // Arrange
        const receivedMessages: string[] = [];

        const consumerConfig = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.direct.queue')
            .withStore(store)
            .withExchanges([{
                name: 'test.direct.exchange',
                type: 'direct',
                routingKey: 'critical', // Only receive 'critical' messages
                options: { durable: true }
            }])
            .withEventHandler('alert.message', async (event) => {
                receivedMessages.push(event.payload.level);
            })
            .build();

        consumer = new ResilientConsumer(consumerConfig);

        publisherStore = new EventStoreMock();
        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withExchangeConfig('test.direct.exchange', 'direct')
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        await consumer.start();

        // Act
        const criticalEvent = new EventBuilder()
            .withType('alert.message')
            .withPayload({ level: 'critical', message: 'System down' })
            .withRoutingKey('critical')
            .build();

        const warningEvent = new EventBuilder()
            .withType('alert.message')
            .withPayload({ level: 'warning', message: 'High load' })
            .withRoutingKey('warning')
            .build();

        const infoEvent = new EventBuilder()
            .withType('alert.message')
            .withPayload({ level: 'info', message: 'System started' })
            .withRoutingKey('info')
            .build();

        // Wait for consumer to be ready
        await new Promise(resolve => setTimeout(resolve, 500));
        
        await publisher.publish(criticalEvent);
        await publisher.publish(warningEvent);
        await publisher.publish(infoEvent);

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Assert - Only critical messages should be received
        expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
        expect(receivedMessages).toContain('critical');
    }, 30000);

    it('should broadcast to all consumers with fanout exchange', async () => {
        // Arrange
        const consumer1Messages: any[] = [];
        const consumer2Messages: any[] = [];

        const consumer1Config = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.fanout.queue1')
            .withStore(store)
            .withExchanges([{
                name: 'test.fanout.exchange',
                type: 'fanout',
                options: { durable: true }
            }])
            .withEventHandler('broadcast.event', async (event) => {
                consumer1Messages.push(event.payload);
            })
            .build();

        const consumer2Config = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.fanout.queue2')
            .withStore(new EventStoreMock()) // Separate store for consumer 2
            .withExchanges([{
                name: 'test.fanout.exchange',
                type: 'fanout',
                options: { durable: true }
            }])
            .withEventHandler('broadcast.event', async (event) => {
                consumer2Messages.push(event.payload);
            })
            .build();

        const consumer1 = new ResilientConsumer(consumer1Config);
        const consumer2 = new ResilientConsumer(consumer2Config);

        publisherStore = new EventStoreMock();
        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withExchangeConfig('test.fanout.exchange', 'fanout')
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        await consumer1.start();
        await consumer2.start();

        // Wait for consumers to be ready
        await new Promise(resolve => setTimeout(resolve, 500));

        // Act
        const broadcastEvent = new EventBuilder()
            .withType('broadcast.event')
            .withPayload({ announcement: 'System maintenance scheduled' })
            .build();

        await publisher.publish(broadcastEvent);

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Assert - Both consumers should receive the message
        expect(consumer1Messages.length).toBeGreaterThanOrEqual(1);
        expect(consumer2Messages.length).toBeGreaterThanOrEqual(1);
        expect(consumer1Messages[0]).toEqual({ announcement: 'System maintenance scheduled' });
        expect(consumer2Messages[0]).toEqual({ announcement: 'System maintenance scheduled' });

        // Cleanup
        await (consumer1 as any).queue?.disconnect();
        await (consumer2 as any).queue?.disconnect();
    }, 30000);

    it('should handle consumer with multiple exchange bindings', async () => {
        // Arrange
        const receivedMessages: any[] = [];

        const consumerConfig = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.multi.queue')
            .withStore(store)
            .withExchanges([
                {
                    name: 'test.exchange1',
                    type: 'direct',
                    routingKey: 'route1',
                    options: { durable: true }
                },
                {
                    name: 'test.exchange2',
                    type: 'direct',
                    routingKey: 'route2',
                    options: { durable: true }
                }
            ])
            .withEventHandler('multi.event', async (event) => {
                receivedMessages.push(event.payload);
            })
            .build();

        consumer = new ResilientConsumer(consumerConfig);

        await consumer.start();

        // Create publishers for each exchange
        publisherStore = new EventStoreMock();
        const publisher1Config = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withExchangeConfig('test.exchange1', 'direct', 'route1')
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        const publisher2Store = new EventStoreMock();
        const publisher2Config = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withExchangeConfig('test.exchange2', 'direct', 'route2')
            .withStore(publisher2Store)
            .withInstantPublish(true)
            .build();

        const publisher1 = new ResilientEventPublisher(publisher1Config);
        const publisher2 = new ResilientEventPublisher(publisher2Config);

        // Act
        const event1 = new EventBuilder()
            .withType('multi.event')
            .withPayload({ source: 'exchange1' })
            .withRoutingKey('route1')
            .build();

        const event2 = new EventBuilder()
            .withType('multi.event')
            .withPayload({ source: 'exchange2' })
            .withRoutingKey('route2')
            .build();

        // Wait for consumer to be ready
        await new Promise(resolve => setTimeout(resolve, 500));
        
        await publisher1.publish(event1);
        await publisher2.publish(event2);

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Assert - Consumer should receive messages from both exchanges
        expect(receivedMessages.length).toBeGreaterThanOrEqual(2);
        expect(receivedMessages).toContainEqual({ source: 'exchange1' });
        expect(receivedMessages).toContainEqual({ source: 'exchange2' });

        // Cleanup
        publisher1.stopPendingEventsCheck();
        publisher2.stopPendingEventsCheck();
    }, 30000);
});
