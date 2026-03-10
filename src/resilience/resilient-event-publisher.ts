import { AmqpQueue } from '../broker/amqp-queue';
import { log } from '../logger/logger';
import { EventMessage, EventPublishStatus, ResilientPublisherConfig } from "../types";

/**
 * Handles publishing of events with retry and dead-letter support.
 */
export class ResilientEventPublisher {
    private readonly queue: AmqpQueue;
    private pendingEventsInterval?: NodeJS.Timeout;
    private idleTimer?: NodeJS.Timeout;
    private readonly instantPublish: boolean;
    private storeConnected: boolean = false;
    private connected: boolean = false;
    private lastPublishTime: number = 0;
    private pendingOperations: number = 0;
    private readonly maxConcurrentPublishes: number = 100; // Limit concurrent operations

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
                log('debug', `[Publisher] Checking store connection (attempt ${attempt}/${maxRetries})...`);

                // Intentar una operación simple para verificar la conexión
                // Usamos un evento de prueba con un ID único
                const testEvent: EventMessage = {
                    messageId: 'bb6c36b7-fa5a-4bf3-82b1-9cd7815f6c26',
                    type: '__health_check__',
                    payload: {}
                };

                await this.config.store.getEvent(testEvent);

                this.storeConnected = true;
                log('info', '[Publisher] Store connection established');
                return;
            } catch (error) {
                log('debug', `[Publisher] Store connection attempt ${attempt}/${maxRetries} failed`, error);

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
        if (this.connected && !this.queue.closed) {
            return;
        }

        // If queue was closed, we need to reconnect
        if (this.queue.closed) {
            log('debug', '[Publisher] Queue was closed, creating new connection...');
            this.connected = false;
        }

        log('debug', '[Publisher] Connecting to RabbitMQ...');
        await this.queue.connect();
        this.connected = true;
        this.lastPublishTime = Date.now();
        log('debug', '[Publisher] Connected to RabbitMQ');

        // Start idle timeout monitoring if configured
        this.startIdleMonitoring();
    }

    /**
     * Starts monitoring for idle connections and closes them after timeout.
     * @private
     */
    private startIdleMonitoring(): void {
        const idleTimeout = this.config.idleTimeoutMs ?? 10000; // Default 10 seconds

        if (idleTimeout <= 0) {
            return;
        }

        // Clear any existing timer
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }

        this.idleTimer = setTimeout(async () => {
            const idleTime = Date.now() - this.lastPublishTime;

            // Only close if idle AND no pending operations
            if (idleTime >= idleTimeout && this.connected && this.pendingOperations === 0) {
                log('debug', `[Publisher] Connection idle for ${idleTime}ms with no pending operations, closing...`);
                try {
                    await this.disconnect();
                } catch (error) {
                    log('error', '[Publisher] Error during idle disconnect', error);
                }
            } else if (this.connected) {
                // Reschedule check if still connected
                if (this.pendingOperations > 0) {
                    log('debug', `[Publisher] Idle check skipped: ${this.pendingOperations} operations pending`);
                }
                this.startIdleMonitoring();
            }
        }, idleTimeout);
    }

    /**
     * Resets the idle timer by updating the last publish time.
     * @private
     */
    private resetIdleTimer(): void {
        this.lastPublishTime = Date.now();

        // Restart idle monitoring (default 10s if not configured)
        const idleTimeout = this.config.idleTimeoutMs ?? 10000;
        if (idleTimeout > 0) {
            this.startIdleMonitoring();
        }
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
        // Wait if we've reached the concurrency limit
        while (this.pendingOperations >= this.maxConcurrentPublishes) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        log('debug', `[Publisher] Publishing message ${event.messageId} (type: ${event.type})`);

        this.pendingOperations++;
        try {
            const store = this.config.store;

            // Single decision: should we publish to RabbitMQ now?
            // - storeOnly: user explicitly wants store-only, no publish
            // - !instantPublish && store: deferred mode, events are sent later via processPendingEvents()
            // - !store: no persistence, must publish immediately
            const shouldPublishNow = !options?.storeOnly && (this.instantPublish || !store);

            // Si hay store configurado, verificar y guardar el evento
            if (store) {
                log('debug', `[Publisher] Checking store connection...`);
                // Verificar conexión al store antes de cualquier operación
                if (!this.storeConnected) {
                    log('debug', `[Publisher] Store not connected, attempting connection...`);
                    await this.checkStoreConnection();
                }

                log('debug', `[Publisher] Checking for duplicate message ${event.messageId}...`);
                const existing = await store.getEvent(event);
                if (existing) {
                    log('warn', `[Publisher] Duplicate message detected: ${event.messageId}, skipping`);
                    return;
                }

                event.status = EventPublishStatus.PENDING;
                log('debug', `[Publisher] Saving event ${event.messageId} to store...`);
                await store.saveEvent(event);
            } else {
                log('debug', `[Publisher] No store configured, proceeding without persistence`);
                // If no store, still mark status locally for callers if desired
                event.status = EventPublishStatus.PENDING;
            }

            if (shouldPublishNow) {
                log('debug', `[Publisher] Publishing message ${event.messageId} to RabbitMQ...`);

                await this.connect();
                this.resetIdleTimer();

                const destination = this.config.queue ?? this.config.exchange?.name!;
                log('debug', `[Publisher] Destination: ${destination}${this.config.exchange ? ` (exchange: ${this.config.exchange.name}, routing key: ${event.routingKey ?? 'none'})` : ''}`);

                await this.queue.publish(
                    destination,
                    event,
                    {
                        exchange: this.config.exchange
                    }
                );

                if (store) {
                    log('debug', `[Publisher] Updating event ${event.messageId} status to PUBLISHED...`);
                    await store.updateEventStatus(event, EventPublishStatus.PUBLISHED);
                }
                log('info', `[Publisher] Message ${event.messageId} published successfully`);
            } else {
                log('debug', `[Publisher] Message ${event.messageId} stored for later delivery`);
            }
        } catch (error) {
            log('error', `[Publisher] Failed to publish message ${event.messageId}`, error);

            if (this.config.store) {
                try {
                    log('debug', `[Publisher] Updating event ${event.messageId} status to ERROR...`);
                    await this.config.store.updateEventStatus(event, EventPublishStatus.ERROR);
                } catch (err) {
                    log('error', `[Publisher] Failed to update event status in store`, err);
                }
            }
            throw error;
        } finally {
            this.pendingOperations--;
        }
    }

    /**
     * Gracefully closes connection to broker.
     * This is a public method that should be called when the publisher is no longer needed.
     */
    public async disconnect(): Promise<void> {
        if (!this.connected) {
            return;
        }

        // Clear idle timer
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }

        log('debug', '[Publisher] Disconnecting from RabbitMQ...');
        await this.queue.disconnect();
        this.connected = false;
        log('debug', '[Publisher] Disconnected from RabbitMQ');
    }

    /**
     * Starts the periodic check for pending events.
     * @private
     */
    private startPendingEventsCheck(): void {
        log('debug', `[Publisher] Pending events check enabled (interval: ${this.config.pendingEventsCheckIntervalMs}ms)`);

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
            log('debug', '[Publisher] Stopped pending events check');
        }
    }

    /**
     * Checks if the publisher is currently connected to RabbitMQ.
     * @returns True if connected, false otherwise
     */
    public isConnected(): boolean {
        return this.connected;
    }

    /**
     * Processes all pending events from the store and sends them in chronological order.
     * Each batch gets its own fresh RabbitMQ connection to avoid stale channel issues.
     * Events are retrieved from oldest to newest based on their timestamp.
     */
    async processPendingEvents(): Promise<void> {
        log('debug', '[Publisher] Checking for pending events...');

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
                log('debug', '[Publisher] Store not connected, attempting connection...');
                await this.checkStoreConnection();
            }

            const BATCH_SIZE = 10;
            let totalSuccess = 0;
            let totalErrors = 0;
            let batchNumber = 0;

            // Procesar en lotes de BATCH_SIZE hasta que no queden más eventos pendientes
            while (true) {
                batchNumber++;
                log('debug', `[Publisher] Fetching pending events batch #${batchNumber} (limit: ${BATCH_SIZE})...`);

                const rawResult = await this.config.store.getPendingEvents!(EventPublishStatus.PENDING, BATCH_SIZE);
                const pendingEvents: EventMessage[] = Array.isArray(rawResult) ? rawResult : Array.from(rawResult as any);

                if (!pendingEvents || pendingEvents.length === 0) {
                    if (batchNumber === 1) {
                        log('debug', '[Publisher] No pending events found');
                    }
                    break;
                }

                log('info', `[Publisher] Processing batch #${batchNumber} with ${pendingEvents.length} event(s)`);

                // Ordenar del más antiguo al más nuevo basado en timestamp
                const sortedEvents = pendingEvents.sort((a, b) => {
                    const timeA = a.properties?.timestamp || 0;
                    const timeB = b.properties?.timestamp || 0;
                    return timeA - timeB;
                });

                // Fresh connection for each batch
                try {
                    await this.ensureFreshConnection();
                } catch (connError) {
                    log('error', `[Publisher] Failed to establish connection for batch #${batchNumber}, aborting. ${pendingEvents.length} messages will be retried later.`, connError);
                    break;
                }

                let batchAborted = false;

                for (let i = 0; i < sortedEvents.length; i++) {
                    const event = sortedEvents[i];
                    log('debug', `[Publisher] Processing pending event ${i + 1}/${sortedEvents.length}: ${event.messageId}`);

                    try {
                        const destination = this.config.queue ?? this.config.exchange?.name!;

                        await this.queue.publish(
                            destination,
                            event,
                            {
                                exchange: this.config.exchange
                            }
                        );

                        log('debug', `[Publisher] Updating status to PUBLISHED for message ${event.messageId}...`);
                        await this.config.store.updateEventStatus(event, EventPublishStatus.PUBLISHED);
                        totalSuccess++;
                    } catch (error) {
                        totalErrors++;
                        log('error', `[Publisher] Failed to publish pending message ${event.messageId}`, error);

                        try {
                            await this.config.store.updateEventStatus(event, EventPublishStatus.ERROR);
                        } catch (updateError) {
                            log('error', `[Publisher] Failed to update ERROR status for ${event.messageId}`, updateError);
                        }

                        // If the channel/connection died, abort this batch immediately.
                        // Remaining messages stay as PENDING and will be picked up in the next batch
                        // with a fresh connection.
                        if (this.queue.closed) {
                            const remaining = sortedEvents.length - i - 1;
                            log('warn', `[Publisher] Connection lost during batch #${batchNumber}. Aborting batch, ${remaining} remaining message(s) will be retried in the next cycle.`);
                            batchAborted = true;
                            break;
                        }
                    }
                }

                // Always disconnect after each batch to release resources
                await this.safeDisconnect();

                log('debug', `[Publisher] Batch #${batchNumber} completed. Success: ${totalSuccess}, Errors: ${totalErrors}`);

                // If the batch was aborted due to connection loss, stop processing more batches
                if (batchAborted) {
                    log('warn', `[Publisher] Stopping batch processing due to connection loss in batch #${batchNumber}`);
                    break;
                }

                // Si el lote devolvió menos eventos que BATCH_SIZE, no hay más pendientes
                if (pendingEvents.length < BATCH_SIZE) {
                    break;
                }
            }

            if (totalSuccess > 0 || totalErrors > 0) {
                log('info', `[Publisher] Pending events processing finished. Total batches: ${batchNumber}, Success: ${totalSuccess}, Errors: ${totalErrors}`);
            }
        } catch (error) {
            log('error', '[Publisher] Error during pending events processing', error);
            // Ensure connection is cleaned up on unexpected errors
            await this.safeDisconnect();
            throw error;
        }
    }

    /**
     * Ensures a fresh RabbitMQ connection by force-closing any existing stale connection
     * and creating a new one.
     * @private
     */
    private async ensureFreshConnection(): Promise<void> {
        // Force-close any existing connection (stale or alive) to start clean
        if (this.connected || !this.queue.closed) {
            log('debug', '[Publisher] Closing existing connection before establishing a fresh one...');
            await this.safeDisconnect();
        }

        log('debug', '[Publisher] Establishing fresh connection for batch...');
        await this.queue.connect();
        this.connected = true;
        this.lastPublishTime = Date.now();
        log('debug', '[Publisher] Fresh connection established');
    }

    /**
     * Safely disconnects, handling already-dead connections gracefully.
     * @private
     */
    private async safeDisconnect(): Promise<void> {
        try {
            if (this.queue.closed) {
                // Connection is already dead, just force-close to clean up references
                await this.queue.forceClose();
            } else {
                await this.queue.disconnect();
            }
        } catch (err) {
            log('warn', '[Publisher] Error during safe disconnect, forcing close', err);
            try {
                await this.queue.forceClose();
            } catch {
                // Ignore - best effort cleanup
            }
        }
        this.connected = false;
    }
}
