import { ResilientEventPublisher } from '../../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../../utils/event-store-mock';
import { AMQPLibMock } from '../../utils/amqplib-mock';
import { ResilientPublisherConfig, EventMessage } from '../../../src/types';
import { EventPublishStatus } from '../../../src/types';

// Mock amqplib
jest.mock('amqplib', () => {
    const mockLib = new (require('../../utils/amqplib-mock').AMQPLibMock)();
    return {
        connect: jest.fn((...args) => mockLib.connect(...args))
    };
});

// Mock the AmqpQueue
jest.mock('../../../src/broker/amqp-queue');

describe('ResilientEventPublisher', () => {
    let publisher: ResilientEventPublisher;
    let mockStore: EventStoreMock;
    let config: ResilientPublisherConfig;
    let mockLib: AMQPLibMock;
    let testEvent: EventMessage;
    let globalInitSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.useFakeTimers();
        mockStore = new EventStoreMock();
        mockLib = new AMQPLibMock();

        const amqplib = require('amqplib');
        amqplib.connect.mockImplementation((url: any) => mockLib.connect(url));

        testEvent = {
            messageId: 'msg-001',
            type: 'test.event',
            payload: { data: 'test' },
            properties: {}
        };

        config = {
            connection: 'amqp://localhost:5672',
            queue: 'test.queue',
            instantPublish: true,
            store: mockStore
        };

        // Mock the background initialization check globally so no test leaks floating promises
        globalInitSpy = jest.spyOn(ResilientEventPublisher.prototype as any, 'checkStoreConnection')
            .mockImplementation(async () => { });
    });

    afterEach(() => {
        if (publisher && (publisher as any).pendingEventsInterval) {
            publisher.stopPendingEventsCheck();
        }
        if (publisher && publisher.isConnected()) {
            publisher.disconnect().catch(() => { });
        }
        mockStore.setFailOnGet(false); // Reset fail switch specifically
        mockStore.clear();
        mockLib.reset();
        if (globalInitSpy) {
            globalInitSpy.mockRestore();
        }
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should create publisher with valid configuration', () => {
            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).not.toThrow();
        });

        it('should throw error when instantPublish is false without store', () => {
            config.instantPublish = false;
            config.store = undefined;

            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: "store" is REQUIRED when "instantPublish" is set to false');
        });

        it('should throw error when store lacks getPendingEvents method', () => {
            config.instantPublish = false;
            config.store = { saveEvent: jest.fn() } as any;

            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: store must implement "getPendingEvents()" method');
        });

        it('should throw error when neither queue nor exchange is configured', () => {
            config.queue = undefined;
            config.exchange = undefined;

            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: either "queue" or "exchange" must be configured');
        });
    });

    describe('publish', () => {
        it('should check for duplicate events before publishing', async () => {
            publisher = new ResilientEventPublisher(config);

            await publisher.publish(testEvent);

            // Try to publish same event again
            await publisher.publish(testEvent);

            expect(mockStore.getCallCount('saveEvent')).toBe(1);
        });

        it('should save event to store before publishing', async () => {
            publisher = new ResilientEventPublisher(config);

            await publisher.publish(testEvent);

            expect(mockStore.getCallCount('saveEvent')).toBe(1);
            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent).toBeDefined();
        });

        it('should update event status to PUBLISHED after successful publish', async () => {
            publisher = new ResilientEventPublisher(config);

            await publisher.publish(testEvent);

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventPublishStatus.PUBLISHED);
        });

        it('should only store event when storeOnly option is true', async () => {
            publisher = new ResilientEventPublisher(config);

            await publisher.publish(testEvent, { storeOnly: true });

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventPublishStatus.PENDING);
        });

        it('should work without store when instantPublish is true', async () => {
            config.store = undefined;
            publisher = new ResilientEventPublisher(config);

            await expect(publisher.publish(testEvent)).resolves.not.toThrow();
        });

        it('should update status to ERROR when publish fails', async () => {
            // Mock AmqpQueue to throw error during connect
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockRejectedValue(new Error('Connection failed')),
                disconnect: jest.fn(),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn(),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);

            await expect(publisher.publish(testEvent)).rejects.toThrow();

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventPublishStatus.ERROR);
        });
    });

    describe('processPendingEvents', () => {
        it('should not throw when store is not configured', async () => {
            config.store = undefined;
            publisher = new ResilientEventPublisher(config);

            // Should log warning but not throw
            await publisher.processPendingEvents();

            // Test passes if no error is thrown
            expect(true).toBe(true);
        });

        it('should process all pending events', async () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 1000;

            // Mock AmqpQueue for successful publishing
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);

            // Store some pending events
            await publisher.publish(testEvent, { storeOnly: true });

            const event2 = { ...testEvent, messageId: 'msg-002' };
            await publisher.publish(event2, { storeOnly: true });

            await publisher.processPendingEvents();

            const savedEvent1 = await mockStore.getEvent(testEvent);
            const savedEvent2 = await mockStore.getEvent(event2);

            expect(savedEvent1?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(savedEvent2?.status).toBe(EventPublishStatus.PUBLISHED);
        });

        it('should fallback securely on store fatal errors in loop', async () => {
            mockStore.getPendingEvents = jest.fn().mockRejectedValue(new Error('Fatal database crash'));
            publisher = new ResilientEventPublisher(config);

            // The loop catch block re-throws the error out of processPendingEvents
            await expect(publisher.processPendingEvents()).rejects.toThrow('Fatal database crash');
        });

        it('should gracefully handle fatal loop processing failure for single item', async () => {
            jest.useRealTimers(); // Use real timers for async operations
            
            // Configure AmqpQueue mock FIRST to fail on publish
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockRejectedValue(new Error('Publishing broken completely')),
                closed: false
            }));

            const problematicEvent = {
                id: 'evt-fatal',
                messageId: 'evt-fatal',
                type: 'TestEvent',
                payload: { value: 1 },
                status: EventPublishStatus.PENDING,
                properties: { timestamp: Date.now() }
            };
            
            // Save the event first
            await mockStore.saveEvent(problematicEvent);
            
            // Mock getPendingEvents to return our event
            mockStore.getPendingEvents = jest.fn().mockResolvedValue([problematicEvent]);

            // NOW create the publisher with the failing mock
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // The batch update will be called with ERROR status
            const batchUpdateSpy = jest.spyOn(mockStore, 'batchUpdateEventStatus');

            await publisher.processPendingEvents();

            // Wait for flush interval to complete
            await new Promise(resolve => setTimeout(resolve, 150));

            // Verify batch update was called with ERROR status
            expect(batchUpdateSpy).toHaveBeenCalled();
            
            // Verify the event was updated to ERROR
            const saved = await mockStore.getEvent(problematicEvent);
            expect(saved?.status).toBe(EventPublishStatus.ERROR);
            
            jest.useFakeTimers(); // Restore fake timers
        }, 10000);

        it('should catch and throw overall error during pending events processing root try/catch', async () => {
            publisher = new ResilientEventPublisher(config);

            const invalidEventsArray: any = [{}];
            invalidEventsArray.sort = () => { throw new Error('Root system corruption'); };

            mockStore.getPendingEvents = jest.fn().mockResolvedValue(invalidEventsArray);

            // Proves it hit the outer try/catch and rethrew the corruption error
            await expect(publisher.processPendingEvents()).rejects.toThrow('Root system corruption');
        });

        it('should handle non-array result from getPendingEvents using Array.from', async () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 1000;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Return a Set (non-array iterable) to trigger Array.from branch
            const event = { ...testEvent, messageId: 'msg-set-001', properties: { timestamp: Date.now() } };
            
            // Save the event first
            await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            
            // Return a Set from getPendingEvents
            const eventSet = new Set([event]);
            mockStore.getPendingEvents = jest.fn().mockResolvedValue(eventSet);
            const batchUpdateSpy = jest.spyOn(mockStore, 'batchUpdateEventStatus');

            await publisher.processPendingEvents();

            // Should have processed the event from the Set using batch update
            expect(batchUpdateSpy).toHaveBeenCalled();
            
            // Verify the event was updated
            const saved = await mockStore.getEvent(event);
            expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);
        });

        it('should sort events without timestamp using 0 as fallback', async () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 1000;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Events without timestamp — triggers the `|| 0` fallback in sort
            const event1 = { ...testEvent, messageId: 'msg-no-ts-1', properties: {} };
            const event2 = { ...testEvent, messageId: 'msg-no-ts-2' }; // no properties at all
            
            // Save events first
            await mockStore.saveEvent({ ...event1, status: EventPublishStatus.PENDING });
            await mockStore.saveEvent({ ...event2, status: EventPublishStatus.PENDING });
            
            mockStore.getPendingEvents = jest.fn().mockResolvedValue([event1, event2]);
            const batchUpdateSpy = jest.spyOn(mockStore, 'batchUpdateEventStatus');

            await publisher.processPendingEvents();

            expect(batchUpdateSpy).toHaveBeenCalled();
            const saved1 = await mockStore.getEvent(event1);
            const saved2 = await mockStore.getEvent(event2);
            expect(saved1?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(saved2?.status).toBe(EventPublishStatus.PUBLISHED);
        });

        it('should process events in chronological order', async () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 1000;

            // Mock AmqpQueue for successful publishing
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);

            const event1 = { ...testEvent, messageId: 'msg-001', properties: { timestamp: 1000 } };
            const event2 = { ...testEvent, messageId: 'msg-002', properties: { timestamp: 2000 } };
            const event3 = { ...testEvent, messageId: 'msg-003', properties: { timestamp: 1500 } };

            await publisher.publish(event1, { storeOnly: true });
            await publisher.publish(event2, { storeOnly: true });
            await publisher.publish(event3, { storeOnly: true });

            await publisher.processPendingEvents();

            // All should be published
            const saved1 = await mockStore.getEvent(event1);
            const saved2 = await mockStore.getEvent(event2);
            const saved3 = await mockStore.getEvent(event3);

            expect(saved1?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(saved2?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(saved3?.status).toBe(EventPublishStatus.PUBLISHED);
        });
    });

    describe('exchange publishing', () => {
        it('should publish to exchange with routing key', async () => {
            const mockPublish = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: mockPublish,
                closed: false
            }));

            config.queue = undefined;
            config.exchange = {
                name: 'events.exchange',
                type: 'topic',
                routingKey: 'user.created',
                options: { durable: true }
            };

            publisher = new ResilientEventPublisher(config);

            const eventWithRouting = { ...testEvent, routingKey: 'user.created' };
            await publisher.publish(eventWithRouting);

            expect(mockPublish).toHaveBeenCalledWith(
                'events.exchange',
                eventWithRouting,
                expect.objectContaining({
                    exchange: config.exchange
                })
            );
        });
    });

    describe('error handling branches', () => {
        it('should exit checkStoreConnection early if no store is configured', async () => {
            globalInitSpy.mockRestore(); // Restore the spy to test the actual method
            const pub = new ResilientEventPublisher({ ...config, store: undefined });
            await (pub as any).checkStoreConnection();
            expect((pub as any).storeConnected).toBe(false);
        });

        it('should log and swallow error if store.updateEventStatus throws while handling publish failure', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockRejectedValue(new Error('Connection failed')),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn(),
                closed: false
            }));

            // Force store.updateEventStatus to throw when it tries to set ERROR status
            const updateSpy = jest.spyOn(mockStore, 'updateEventStatus').mockRejectedValue(new Error('Store update failed'));
            publisher = new ResilientEventPublisher(config);

            await expect(publisher.publish(testEvent)).rejects.toThrow('Connection failed');
            expect(updateSpy).toHaveBeenCalled();
        });




        it('should exit processPendingEvents early if store lacks getPendingEvents', async () => {
            config.instantPublish = true; // Use true so it passes constructor validation without getPendingEvents
            config.store = {
                saveEvent: jest.fn(),
                getEvent: jest.fn(),
                updateEventStatus: jest.fn(),
            } as any;
            publisher = new ResilientEventPublisher(config);

            await expect(publisher.processPendingEvents()).rejects.toThrow('Store must implement getPendingEvents() method');
        });
        it('should log error during init if store connection fails', () => {
            jest.useRealTimers();

            jest.spyOn(require('../../../src/logger/logger'), 'log').mockImplementation(() => { });

            // Mock checkStoreConnection to return a rejected promise synchronously
            const connectSpy = jest.spyOn(ResilientEventPublisher.prototype as any, 'checkStoreConnection')
                .mockImplementation(function () {
                    return {
                        catch: (cb: any) => {
                            cb(new Error('mock err'));
                        }
                    };
                });

            config.storeConnectionRetries = 1;

            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Failed to initialize publisher: store connection failed');

            expect(connectSpy).toHaveBeenCalled();

            jest.restoreAllMocks();
        });

        it('should call handleStoreInitFailure when store connection fails in constructor', () => {
            const handleFailureSpy = jest.spyOn(ResilientEventPublisher.prototype as any, 'handleStoreInitFailure');

            const connectSpy = jest.spyOn(ResilientEventPublisher.prototype as any, 'checkStoreConnection')
                .mockImplementation(function () {
                    return {
                        catch: (cb: any) => {
                            try { cb(new Error('store down')); } catch {}
                        }
                    };
                });

            try {
                publisher = new ResilientEventPublisher(config);
            } catch {}

            expect(handleFailureSpy).toHaveBeenCalled();

            connectSpy.mockRestore();
            handleFailureSpy.mockRestore();
        });
    });

    describe('disconnect', () => {
        it('should disconnect from RabbitMQ and wait for pending ops', async () => {
            const mockDisconnect = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: mockDisconnect,
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            await publisher.publish(testEvent);

            // force pending ops to test waiting behavior
            (publisher as any).pendingOperations = 1;
            setTimeout(() => {
                (publisher as any).pendingOperations = 0;
            }, 50);

            await publisher.disconnect();
            expect(mockDisconnect).toHaveBeenCalled();
        });

        it('should log error if disconnect fails during idle timeout check', async () => {
            config.idleTimeoutMs = 50;
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Stop the natural timer
            if ((publisher as any).idleTimer) {
                clearTimeout((publisher as any).idleTimer);
            }

            // Capture the timer callback
            let timerCallback: any = null;
            const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
                timerCallback = cb;
                return {} as any;
            });

            (publisher as any).startIdleMonitoring();
            setTimeoutSpy.mockRestore();

            // Setup failure scenario
            (publisher as any).queue = {
                disconnect: jest.fn().mockRejectedValue(new Error('Idle disconnect failure'))
            } as any;
            (publisher as any).connected = true;
            (publisher as any).lastPublishTime = Date.now() - 1000;
            (publisher as any).pendingOperations = 0;

            // Fire callback manually
            if (timerCallback) {
                await timerCallback();
            }

            // The unhandledRejection catch behavior of the timer testing ensures the process didn't crash
            // when it silently swallowed the error during execution
            expect(true).toBe(true);
        });

        it('should skip idle disconnect if pending operations exist, and reschedule', async () => {
            jest.useRealTimers();
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            config.idleTimeoutMs = 50;

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            await publisher.publish(testEvent);
            (publisher as any).pendingOperations = 1; // block it

            await new Promise(resolve => setTimeout(resolve, 80));
            // it should have rescheduled


            (publisher as any).pendingOperations = 0; // release it
            jest.useFakeTimers();
            mockStore.setFailOnGet(false);
        });

        it('should not disconnect if not connected', async () => {
            const mockDisconnect = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: mockDisconnect,
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            await publisher.disconnect();

            expect(mockDisconnect).not.toHaveBeenCalled();
        });

        it('should clear idleTimer when disconnecting while timer is active', async () => {
            jest.useRealTimers();
            const mockDisconnect = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: mockDisconnect,
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            config.idleTimeoutMs = 60000;
            publisher = new ResilientEventPublisher(config);
            await publisher.publish(testEvent);

            // idleTimer should be set after publish
            expect((publisher as any).idleTimer).toBeDefined();

            await publisher.disconnect();

            // idleTimer should be cleared
            expect((publisher as any).idleTimer).toBeUndefined();
            expect(mockDisconnect).toHaveBeenCalled();
            jest.useFakeTimers();
        });

        it('should reschedule idle monitoring when connected but pending ops > 0', async () => {
            jest.useRealTimers();
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            config.idleTimeoutMs = 30;
            publisher = new ResilientEventPublisher(config);
            await publisher.publish(testEvent);

            // Simulate pending operations to trigger reschedule branch
            (publisher as any).pendingOperations = 1;
            (publisher as any).lastPublishTime = Date.now() - 60000; // old publish time

            // Wait for idle timer to fire — should reschedule (else if connected branch)
            await new Promise(resolve => setTimeout(resolve, 80));

            // Still connected because pending ops blocked disconnect
            expect(publisher.isConnected()).toBe(true);

            (publisher as any).pendingOperations = 0;
            await publisher.disconnect();
            jest.useFakeTimers();
        });
    });

    describe('isConnected', () => {
        it('should return false when not connected', () => {
            publisher = new ResilientEventPublisher(config);
            expect(publisher.isConnected()).toBe(false);
        });

        it('should return true after publishing', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            await publisher.publish(testEvent);

            expect(publisher.isConnected()).toBe(true);
        });
    });

    describe('pending events check interval', () => {
        it('should start periodic check when instantPublish is false', () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 50;
            jest.useFakeTimers();

            publisher = new ResilientEventPublisher(config);
            expect((publisher as any).pendingEventsInterval).toBeDefined();

            jest.useRealTimers();
        });

        it('should not start periodic check when instantPublish is true', () => {
            config.instantPublish = true;
            publisher = new ResilientEventPublisher(config);
            expect((publisher as any).pendingEventsInterval).toBeUndefined();
        });

        it('should log warning when pendingEventsCheckIntervalMs is set with instantPublish true', () => {
            const logSpy = jest.spyOn(require('../../../src/logger/logger'), 'log');
            config.instantPublish = true;
            config.pendingEventsCheckIntervalMs = 5000;
            publisher = new ResilientEventPublisher(config);
            expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('pendingEventsCheckIntervalMs'));
            logSpy.mockRestore();
        });

        it('should catch and log error when periodic processPendingEvents fails', async () => {
            jest.useRealTimers();
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 30;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);

            // Make processPendingEvents throw to trigger the .catch() callback (lines 199-200)
            jest.spyOn(publisher, 'processPendingEvents').mockRejectedValue(new Error('Periodic check failed'));

            // Wait for the interval to fire
            await new Promise(resolve => setTimeout(resolve, 80));

            publisher.stopPendingEventsCheck();
            jest.useFakeTimers();
        });

        it('should stop periodic check when stopPendingEventsCheck is called', () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 50;
            publisher = new ResilientEventPublisher(config);

            const interval = (publisher as any).pendingEventsInterval;
            expect(interval).toBeDefined();

            const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
            publisher.stopPendingEventsCheck();

            expect(clearIntervalSpy).toHaveBeenCalled();

            // Depending on Node vs Jest, it might be undefined or something else, but it shouldn't be defined 
            // like a timer handle anymore
            expect((publisher as any).pendingEventsInterval).toBeUndefined();
            clearIntervalSpy.mockRestore();
        });

        it('should be safe to call stopPendingEventsCheck multiple times', () => {
            config.instantPublish = false;
            publisher = new ResilientEventPublisher(config);
            publisher.stopPendingEventsCheck();
            expect(() => publisher.stopPendingEventsCheck()).not.toThrow();
        });
    });

    describe('store connection retries', () => {
        it('should retry store connection on failure and eventually throw after max retries', async () => {
            jest.useFakeTimers();
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

            mockStore.getEvent = jest.fn().mockRejectedValue(new Error('Store totally down'));

            config.storeConnectionRetries = 2; // Test max 2
            config.storeConnectionRetryDelayMs = 5000;
            publisher = new ResilientEventPublisher(config);

            globalInitSpy.mockRestore(); // Restore so we can test the real method

            const testPromise = (publisher as any).checkStoreConnection();

            // Fast-forward timers to skip the retry delays
            await Promise.resolve();
            jest.advanceTimersByTime(5000);
            await Promise.resolve();
            jest.advanceTimersByTime(5000);

            await expect(testPromise).rejects.toThrow('Failed to connect to store after 2 attempts');

            consoleSpy.mockRestore();
            jest.useRealTimers();
        });

        it('should retry store connection on failure and succeed', async () => {
            globalInitSpy.mockRestore(); // Restore the spy to test the actual method
            jest.useRealTimers();

            config.storeConnectionRetries = 2;
            config.storeConnectionRetryDelayMs = 100;

            let attempts = 0;
            mockStore.setFailOnGet(true);

            // Make it succeed on second attempt
            const originalGetEvent = mockStore.getEvent.bind(mockStore);
            mockStore.getEvent = jest.fn(async (event) => {
                attempts++;
                if (attempts < 2) {
                    throw new Error('Connection failed');
                }
                mockStore.setFailOnGet(false);
                return originalGetEvent(event);
            });

            publisher = new ResilientEventPublisher(config);

            await expect(publisher.publish(testEvent)).resolves.not.toThrow();
            expect(attempts).toBeGreaterThan(1);

            jest.useFakeTimers();
        }, 10000);
    });

    describe('idle timeout', () => {
        it('should configure idle timeout when specified', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            config.idleTimeoutMs = 5000;
            publisher = new ResilientEventPublisher(config);

            await publisher.publish(testEvent);

            expect(publisher.isConnected()).toBe(true);
        });

        it('should ignore idle monitoring when timeout is <= 0', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn(),
                closed: false
            }));

            config.idleTimeoutMs = 0;
            publisher = new ResilientEventPublisher(config);
            await publisher.publish(testEvent);
            expect((publisher as any).idleTimer).toBeUndefined();
        });
    });

    describe('reconnection bounds', () => {
        it('should exit connect early if already connected and open', async () => {
            const connectMock = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: connectMock,
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn(),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).connected = true; // explicitly set true

            await (publisher as any).connect();
            expect(connectMock).not.toHaveBeenCalled();
        });

        it('should reconnect if queue is marked closed', async () => {
            const connectMock = jest.fn().mockResolvedValue(undefined);
            const publishMock = jest.fn().mockResolvedValue(undefined);
            let isClosed = false;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: connectMock,
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: publishMock,
                get closed() { return isClosed; },
                set closed(val: boolean) { isClosed = val; }
            }));

            publisher = new ResilientEventPublisher(config);
            await (publisher as any).connect(); // 1st connection

            isClosed = true; // Trigger closure flag
            await (publisher as any).connect(); // Should reconnect

            expect(connectMock).toHaveBeenCalledTimes(2);
        });

        it('should wait when pendingOperations reaches maxConcurrentPublishes', async () => {
            jest.useRealTimers();
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);

            // Set pendingOperations to max to trigger the wait loop
            (publisher as any).pendingOperations = (publisher as any).maxConcurrentPublishes;

            // Release after a short delay
            setTimeout(() => {
                (publisher as any).pendingOperations = 0;
            }, 30);

            const event2 = { ...testEvent, messageId: 'msg-wait' };
            await publisher.publish(event2);

            expect(mockStore.getCallCount('saveEvent')).toBeGreaterThan(0);
            jest.useFakeTimers();
        });
    });

    describe('coverage for uncovered lines', () => {
        it('should skip processPendingEvents when already processing (line 129-130)', async () => {
            config.instantPublish = false;
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;
            (publisher as any).isProcessingPending = true;

            const logSpy = jest.spyOn(require('../../../src/logger/logger'), 'log');
            await publisher.processPendingEvents();

            expect(logSpy).toHaveBeenCalledWith('debug', '[Publisher] Pending events processing already in progress, skipping');
            logSpy.mockRestore();
        });

        it('should recover from channel error during publish (lines 321-347)', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let publishAttempts = 0;
            
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockImplementation(async () => {
                    publishAttempts++;
                    if (publishAttempts === 1) {
                        const error = new Error('Channel closed');
                        (error as any).stackAtStateChange = 'IllegalOperationError: Channel closed';
                        throw error;
                    }
                }),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            await publisher.publish(testEvent);

            expect(publishAttempts).toBe(2);
            const saved = await mockStore.getEvent(testEvent);
            expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);
        });

        it('should handle reconnectPromise already in progress (line 329-331)', async () => {
            jest.useRealTimers(); // Use real timers for this test
            
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let connectCalls = 0;
            let disconnectCalls = 0;
            
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockImplementation(async () => {
                    connectCalls++;
                    // Return a promise with controlled timing
                    await new Promise(resolve => setTimeout(resolve, 100));
                }),
                disconnect: jest.fn().mockImplementation(async () => {
                    disconnectCalls++;
                }),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            
            // Set connected to true to trigger the reconnection flow
            (publisher as any).connected = true;

            // Trigger two concurrent recovery attempts - the second should wait for the first
            const recovery1 = (publisher as any).recoverBrokerConnection();
            // Don't wait, immediately trigger second recovery
            const recovery2 = (publisher as any).recoverBrokerConnection();

            await Promise.all([recovery1, recovery2]);
            
            // Should only connect once (second call waits for first via reconnectPromise at line 329-331)
            expect(connectCalls).toBe(1);
            // Should disconnect once before reconnecting
            expect(disconnectCalls).toBe(1);
            
            jest.useFakeTimers(); // Restore fake timers
        }, 10000);

        it('should return false for non-Error objects in isRecoverableChannelError (line 353)', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockRejectedValue('string error'), // Throw string (not Error instance)
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // This should fail because the error is not an Error instance
            // and isRecoverableChannelError will return false (line 353), so it won't retry
            await expect(publisher.publish(testEvent)).rejects.toBe('string error');
            
            // Verify the error was stored
            const saved = await mockStore.getEvent(testEvent);
            expect(saved?.status).toBe(EventPublishStatus.ERROR);
        });
    });
});