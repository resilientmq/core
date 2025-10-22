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
    private async connect(): Promise<void> {
        await this.queue.connect();
    }

    /**
     * Publishes an event, applying resilience (store, retry headers, etc).
     * If no store is provided, publishing proceeds without persistence.
     *
     * @param event - Event payload to publish.
     */
    async publish(event: EventMessage): Promise<void> {
        try {
            await this.connect();

            const store = this.config.store;

            if (store) {
                const existing = await store.getEvent(event);
                if (existing) {
                    log('warn', `[Publisher] Duplicate message detected: ${event.messageId}`);
                    await this.disconnect();
                    return;
                }

                event.status = EventPublishStatus.PENDING;
                await store.saveEvent(event);
            } else {
                // If no store, still mark status locally for callers if desired
                event.status = EventPublishStatus.PENDING;
            }

            await this.queue.publish(
                this.config.queue ?? this.config.exchange?.name!,
                event,
                {
                    exchange: this.config.exchange
                }
            );
            await this.disconnect();

            if (store) {
                await store.updateEventStatus(event, EventPublishStatus.PUBLISHED);
            }

            log('info', `[Publisher] Message ${event.messageId} published`);
        } catch (error) {
            if (this.config.store) {
                try {
                    await this.config.store.updateEventStatus(event, EventPublishStatus.ERROR);
                } catch (err) {
                    log('error', `[Publisher] Failed to update event status in store for ${event.messageId}`, err);
                }
            }
            log('error', `[Publisher] Failed to publish message ${event.messageId}`, error);
        }
    }

    /**
     * Gracefully closes connection to broker.
     */
    private async disconnect(): Promise<void> {
        await this.queue.disconnect();
    }
}
