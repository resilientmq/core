import { AmqpQueue } from '../broker/amqp-queue';
import { log } from '../logger/logger';
import {EventMessage, EventPublishStatus, ResilientPublisherConfig} from "../types";

/**
 * Handles publishing of events with retry and dead-letter support.
 */
export class ResilientEventPublisher {
    private readonly queue: AmqpQueue;
    private pendingEventsInterval?: NodeJS.Timeout;
    private readonly instantPublish: boolean;
    private storeConnected: boolean = false;

    constructor(private readonly config: ResilientPublisherConfig) {
        // Validar configuración
        this.validateConfig();

        // Establecer instantPublish (por defecto true)
        this.instantPublish = config.instantPublish !== false;

        this.queue = new AmqpQueue(this.config.connection);

        // Verificar conexión al store si está configurado
        if (this.config.store) {
            this.checkStoreConnection().catch((error) => {
                log('error', '[Publisher] Failed to connect to store during initialization', error);
                throw new Error('Failed to initialize publisher: store connection failed');
            });
        }

        // Iniciar chequeo periódico de eventos pendientes solo si:
        // 1. instantPublish está en false
        // 2. Hay un intervalo configurado
        if (!this.instantPublish && this.config.pendingEventsCheckIntervalMs && this.config.pendingEventsCheckIntervalMs > 0) {
            this.startPendingEventsCheck();
        }
    }

    /**
     * Validates the configuration and throws errors if invalid.
     * @private
     */
    private validateConfig(): void {
        const instantPublish = this.config.instantPublish !== false;

        // Si instantPublish está en false, se requiere un store
        if (!instantPublish && !this.config.store) {
            throw new Error(
                '[Publisher] Configuration error: "store" is REQUIRED when "instantPublish" is set to false'
            );
        }

        // Si instantPublish está en false, se requiere que el store tenga getPendingEvents
        if (!instantPublish && this.config.store && !this.config.store.getPendingEvents) {
            throw new Error(
                '[Publisher] Configuration error: store must implement "getPendingEvents()" method when "instantPublish" is set to false'
            );
        }

        // Advertir si pendingEventsCheckIntervalMs está configurado pero instantPublish es true
        if (instantPublish && this.config.pendingEventsCheckIntervalMs) {
            log('warn', '[Publisher] Configuration warning: "pendingEventsCheckIntervalMs" has no effect when "instantPublish" is true');
        }

        // Validar que al menos queue o exchange esté configurado
        if (!this.config.queue && !this.config.exchange) {
            throw new Error('[Publisher] Configuration error: either "queue" or "exchange" must be configured');
        }
    }

    /**
     * Checks the store connection with retry logic.
     * @private
     */
    private async checkStoreConnection(): Promise<void> {
        if (!this.config.store) {
            this.storeConnected = false;
            return;
        }

        const maxRetries = this.config.storeConnectionRetries ?? 3;
        const retryDelay = this.config.storeConnectionRetryDelayMs ?? 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                log('info', `[Publisher] Checking store connection (attempt ${attempt}/${maxRetries})...`);

                // Intentar una operación simple para verificar la conexión
                // Usamos un evento de prueba con un ID único
                const testEvent: EventMessage = {
                    messageId: `__health_check_${Date.now()}__`,
                    type: '__health_check__',
                    payload: {},
                    status: EventPublishStatus.PENDING
                };

                await this.config.store.getEvent(testEvent);

                this.storeConnected = true;
                log('info', '[Publisher] Store connection established successfully');
                return;
            } catch (error) {
                log('warn', `[Publisher] Store connection attempt ${attempt}/${maxRetries} failed`, error);

                if (attempt === maxRetries) {
                    this.storeConnected = false;
                    throw new Error(`Failed to connect to store after ${maxRetries} attempts`);
                }

                // Esperar antes del siguiente intento
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    /**
     * Initializes the connection and internal queue.
     */
    private async connect(): Promise<void> {
        log('info', '[Publisher] Connecting to RabbitMQ...');
        await this.queue.connect();
        log('info', '[Publisher] Successfully connected to RabbitMQ');
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
        log('info', `[Publisher] Starting publish process for message ${event.messageId} (type: ${event.type})`);

        try {
            const store = this.config.store;

            // Si hay store configurado, verificar y guardar el evento
            if (store) {
                log('info', `[Publisher] Store is configured, checking connection...`);
                // Verificar conexión al store antes de cualquier operación
                if (!this.storeConnected) {
                    log('warn', `[Publisher] Store not connected, attempting connection...`);
                    await this.checkStoreConnection();
                }

                log('info', `[Publisher] Checking for duplicate message ${event.messageId}...`);
                const existing = await store.getEvent(event);
                if (existing) {
                    log('warn', `[Publisher] Duplicate message detected: ${event.messageId}, skipping publish`);
                    return;
                }
                log('info', `[Publisher] No duplicate found for message ${event.messageId}`);

                event.status = EventPublishStatus.PENDING;
                log('info', `[Publisher] Saving event ${event.messageId} to store with status PENDING...`);
                await store.saveEvent(event);
                log('info', `[Publisher] Event ${event.messageId} saved to store successfully`);

                // Si storeOnly está habilitado, solo guardamos el evento sin enviarlo
                if (options?.storeOnly) {
                    log('info', `[Publisher] storeOnly option enabled - message ${event.messageId} stored for later delivery`);
                    return;
                }
            } else {
                log('info', `[Publisher] No store configured, proceeding without persistence`);
                // If no store, still mark status locally for callers if desired
                event.status = EventPublishStatus.PENDING;
            }

            // Publicar solo si instantPublish está habilitado o no hay store
            if (this.instantPublish || !store) {
                log('info', `[Publisher] InstantPublish is enabled, proceeding to publish message ${event.messageId}...`);

                await this.connect();

                const destination = this.config.queue ?? this.config.exchange?.name!;
                log('info', `[Publisher] Publishing message ${event.messageId} to destination: ${destination}`);

                if (this.config.exchange) {
                    log('info', `[Publisher] Using exchange: ${this.config.exchange.name} (type: ${this.config.exchange.type}), routing key: ${event.routingKey ?? '(none)'}`);
                }

                await this.queue.publish(
                    destination,
                    event,
                    {
                        exchange: this.config.exchange
                    }
                );
                log('info', `[Publisher] Message ${event.messageId} sent to RabbitMQ successfully`);

                await this.disconnect();

                if (store) {
                    log('info', `[Publisher] Updating event ${event.messageId} status to PUBLISHED in store...`);
                    await store.updateEventStatus(event, EventPublishStatus.PUBLISHED);
                    log('info', `[Publisher] Event ${event.messageId} status updated in store`);
                }
                log('info', `[Publisher] Message ${event.messageId} published successfully`);
            } else {
                log('info', `[Publisher] InstantPublish disabled - message ${event.messageId} stored and will be sent later`);
            }
        } catch (error) {
            log('error', `[Publisher] Failed to publish message ${event.messageId}`, error);

            if (this.config.store) {
                try {
                    log('info', `[Publisher] Updating event ${event.messageId} status to ERROR in store...`);
                    await this.config.store.updateEventStatus(event, EventPublishStatus.ERROR);
                    log('info', `[Publisher] Event ${event.messageId} status updated to ERROR in store`);
                } catch (err) {
                    log('error', `[Publisher] Failed to update event status in store for ${event.messageId}`, err);
                }
            }
            throw error;
        }
    }

    /**
     * Gracefully closes connection to broker.
     */
    private async disconnect(): Promise<void> {
        log('info', '[Publisher] Disconnecting from RabbitMQ...');
        await this.queue.disconnect();
        log('info', '[Publisher] Successfully disconnected from RabbitMQ');
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
        log('info', '[Publisher] Starting to process pending events...');

        if (!this.config.store) {
            log('warn', '[Publisher] Cannot process pending events: no store configured');
            return;
        }

        if (!this.config.store.getPendingEvents) {
            log('error', '[Publisher] Cannot process pending events: store does not implement getPendingEvents()');
            throw new Error('Store must implement getPendingEvents() method');
        }

        try {
            // Verificar conexión al store antes de procesar
            if (!this.storeConnected) {
                log('warn', '[Publisher] Store not connected, attempting connection before processing pending events...');
                await this.checkStoreConnection();
            }

            log('info', '[Publisher] Fetching pending events from store...');
            // Obtener eventos pendientes
            const pendingEvents = await this.config.store.getPendingEvents(EventPublishStatus.PENDING);

            if (pendingEvents.length === 0) {
                log('info', '[Publisher] No pending events found to process');
                return;
            }

            log('info', `[Publisher] Found ${pendingEvents.length} pending event(s) in store`);

            // Ordenar del más antiguo al más nuevo basado en timestamp
            log('info', '[Publisher] Sorting events by timestamp (oldest first)...');
            const sortedEvents = pendingEvents.sort((a, b) => {
                const timeA = a.properties?.timestamp || 0;
                const timeB = b.properties?.timestamp || 0;
                return timeA - timeB;
            });
            log('info', `[Publisher] Events sorted: ${sortedEvents.length} event(s) ready to process`);

            log('info', `[Publisher] Processing ${sortedEvents.length} pending events...`);

            await this.connect();

            let successCount = 0;
            let errorCount = 0;

            // Procesar cada evento en orden
            for (let i = 0; i < sortedEvents.length; i++) {
                const event = sortedEvents[i];
                log('info', `[Publisher] Processing pending event ${i + 1}/${sortedEvents.length}: ${event.messageId} (type: ${event.type})`);

                try {
                    const destination = this.config.queue ?? this.config.exchange?.name!;
                    log('info', `[Publisher] Publishing pending message ${event.messageId} to destination: ${destination}`);

                    await this.queue.publish(
                        destination,
                        event,
                        {
                            exchange: this.config.exchange
                        }
                    );
                    log('info', `[Publisher] Pending message ${event.messageId} sent to RabbitMQ`);

                    log('info', `[Publisher] Updating status to PUBLISHED for message ${event.messageId}...`);
                    await this.config.store.updateEventStatus(event, EventPublishStatus.PUBLISHED);
                    successCount++;
                    log('info', `[Publisher] Pending message ${event.messageId} published successfully (${successCount}/${sortedEvents.length} completed)`);
                } catch (error) {
                    errorCount++;
                    log('error', `[Publisher] Failed to publish pending message ${event.messageId} (error ${errorCount})`, error);

                    try {
                        log('info', `[Publisher] Updating status to ERROR for failed message ${event.messageId}...`);
                        await this.config.store.updateEventStatus(event, EventPublishStatus.ERROR);
                    } catch (updateError) {
                        log('error', `[Publisher] Failed to update ERROR status for message ${event.messageId}`, updateError);
                    }
                }
            }

            await this.disconnect();
            log('info', `[Publisher] Finished processing pending events: ${successCount} successful, ${errorCount} failed out of ${sortedEvents.length} total`);
        } catch (error) {
            log('error', '[Publisher] Error during pending events processing', error);
            throw error;
        }
    }
}
