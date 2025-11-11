import { AmqpQueue } from '../broker/amqp-queue';
import { log } from '../logger/logger';
import {EventMessage, EventPublishStatus, ResilientPublisherConfig} from "../types";

/**
 * Handles publishing of events with retry and dead-letter support.
 */
export class ResilientEventPublisher {
    private readonly queue: AmqpQueue;
    private pendingEventsInterval?: NodeJS.Timeout;

    constructor(private readonly config: ResilientPublisherConfig) {
        this.queue = new AmqpQueue(this.config.connection);

        // Iniciar chequeo periódico de eventos pendientes si está configurado
        if (this.config.pendingEventsCheckIntervalMs && this.config.pendingEventsCheckIntervalMs > 0) {
            this.startPendingEventsCheck();
        }
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
     * @param options - Publishing options.
     * @param options.storeOnly - If true, only stores the event without sending it immediately.
     */
    async publish(event: EventMessage, options?: { storeOnly?: boolean }): Promise<void> {
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

                // Si storeOnly está habilitado, solo guardamos el evento sin enviarlo
                if (options?.storeOnly) {
                    log('info', `[Publisher] Message ${event.messageId} stored for later delivery`);
                    await this.disconnect();
                    return;
                }
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

    /**
     * Starts the periodic check for pending events.
     * @private
     */
    private startPendingEventsCheck(): void {
        log('info', `[Publisher] Starting pending events check every ${this.config.pendingEventsCheckIntervalMs}ms`);

        this.pendingEventsInterval = setInterval(() => {
            this.processPendingEvents().catch((error) => {
                log('error', '[Publisher] Error during periodic pending events check', error);
            });
        }, this.config.pendingEventsCheckIntervalMs);
    }

    /**
     * Stops the periodic check for pending events.
     * Useful when shutting down the publisher gracefully.
     */
    public stopPendingEventsCheck(): void {
        if (this.pendingEventsInterval) {
            clearInterval(this.pendingEventsInterval);
            this.pendingEventsInterval = undefined;
            log('info', '[Publisher] Stopped pending events check');
        }
    }

    /**
     * Processes all pending events from the store and sends them in chronological order.
     * Events are retrieved from oldest to newest based on their timestamp.
     */
    async processPendingEvents(): Promise<void> {
        if (!this.config.store) {
            log('warn', '[Publisher] Cannot process pending events: no store configured');
            return;
        }

        try {
            // Obtener eventos pendientes
            const pendingEvents = await this.config.store.getPendingEvents(EventPublishStatus.PENDING);

            if (pendingEvents.length === 0) {
                return;
            }

            // Ordenar del más antiguo al más nuevo basado en timestamp
            const sortedEvents = pendingEvents.sort((a, b) => {
                const timeA = a.properties?.timestamp || 0;
                const timeB = b.properties?.timestamp || 0;
                return timeA - timeB;
            });

            log('info', '[Publisher] Starting to process pending events...');
            log('info', `[Publisher] Found ${sortedEvents.length} pending events to process`);

            await this.connect();

            // Procesar cada evento en orden
            for (const event of sortedEvents) {
                try {
                    await this.queue.publish(
                        this.config.queue ?? this.config.exchange?.name!,
                        event,
                        {
                            exchange: this.config.exchange
                        }
                    );

                    await this.config.store.updateEventStatus(event, EventPublishStatus.PUBLISHED);
                    log('info', `[Publisher] Pending message ${event.messageId} published successfully`);
                } catch (error) {
                    await this.config.store.updateEventStatus(event, EventPublishStatus.ERROR);
                    log('error', `[Publisher] Failed to publish pending message ${event.messageId}`, error);
                }
            }

            await this.disconnect();
            log('info', '[Publisher] Finished processing pending events');
        } catch (error) {
            log('error', '[Publisher] Error during pending events processing', error);
            throw error;
        }
    }
}
