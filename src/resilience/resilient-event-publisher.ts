import { AmqpQueue } from '../broker/amqp-queue';
import { log } from '../logger/logger';
import {EventMessage, EventPublishStatus, ResilientPublisherConfig} from "../types";

/**
 * Handles publishing of events with retry and dead-letter support.
 */
export class ResilientEventPublisher {
    private readonly queue: AmqpQueue;

    constructor(private readonly config: ResilientPublisherConfig) {
        this.queue = new AmqpQueue(this.config.connection);
    }

    /**
     * Initializes the connection and internal queue.
     */
    async connect(): Promise<void> {
        await this.queue.connect();
    }

    /**
     * Publishes an event, applying resilience (store, retry headers, etc).
     *
     * @param event - Event payload to publish.
     */
    async publish(event: EventMessage): Promise<void> {
        try {
            const existing = await this.config.store.getEvent(event);
            if (existing) {
                log('warn', `[Publisher] Duplicate message detected: ${event}`);
                return;
            }

            event.status = EventPublishStatus.PENDING;
            await this.config.store.saveEvent(event);

            await this.queue.publish(
                this.config.queue ?? this.config.exchange?.name!,
                event,
                {
                    exchange: this.config.exchange
                }
            );

            await this.config.store.updateEventStatus(event, EventPublishStatus.PUBLISHED);
            log('info', `[Publisher] Message ${event.messageId} published`);
        } catch (error) {
            await this.config.store.updateEventStatus(event, EventPublishStatus.ERROR);
            log('error', `[Publisher] Failed to publish message ${event.messageId}`, error);
        }
    }

    /**
     * Gracefully closes connection to broker.
     */
    async disconnect(): Promise<void> {
        await this.queue.disconnect();
    }
}
