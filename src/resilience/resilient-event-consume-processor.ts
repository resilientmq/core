import { applyMiddleware } from './middleware';
import { log } from '../logger/logger';
import { EventConsumeStatus, EventMessage, RabbitMQResilientProcessorConfig } from "../types";

/**
 * Handles the lifecycle of consuming events, including retries, deduplication, and DLQ routing.
 */
export class ResilientEventConsumeProcessor {
    private readonly config: RabbitMQResilientProcessorConfig;

    constructor(config: RabbitMQResilientProcessorConfig) {
        this.config = config;
    }

    /**
     * Processes an event message, applying middleware, storing metadata, and invoking a handler.
     * On error, it manages retries or forwards the message to a DLQ if necessary.
     *
     * @param event - The incoming event message from the queue.
     */
    async process(event: EventMessage): Promise<void> {
        const deathHeaders = event.properties?.headers?.['x-death'];
        const attempts = deathHeaders && Array.isArray(deathHeaders) && deathHeaders.length > 0
            ? deathHeaders[0].count || 0
            : 0;

        log('debug', `[Processor] Processing message ${event.messageId} (type: ${event.type}, attempt: ${attempts + 1})`);

        try {
            const control = { skipEvent: false };
            this.config.events?.onEventStart?.(event, control);

            if (control.skipEvent) {
                log('debug', `[Processor] Processing skipped by onEventStart for event ${event.messageId}`);
                return;
            }

            let existing = null;
            if (this.config.store) {
                log('debug', `[Processor] Checking for duplicate event ${event.messageId} in store`);
                existing = await this.config.store.getEvent(event);
            }

            if (existing && attempts === 0) {
                log('warn', `[Processor] Duplicate event detected: ${event.messageId}, skipping`);
                return;
            } else if (existing) {
                log('debug', `[Processor] Updating existing event ${event.messageId} status in store`);
                if (this.config.store) await this.config.store.updateEventStatus(event, event.status as EventConsumeStatus);
            } else {
                log('debug', `[Processor] Saving new event ${event.messageId} to store`);
                if (this.config.store) await this.config.store.saveEvent(event);
            }

            const match = this.config.eventsToProcess.find(e => e.type === event.type);
            if (!match) {
                log('warn', `[Processor] No handler for event type: ${event.type}`);
                if (!this.config.ignoreUnknownEvents) {
                    if (this.config.store) await this.config.store.updateEventStatus(event, EventConsumeStatus.DONE);
                } else {
                    if (this.config.store) await this.config.store.deleteEvent(event);
                }
                return;
            }

            const runner = async () => {
                log('debug', `[Processor] Updating event ${event.messageId} status to PROCESSING`);
                if (this.config.store) await this.config.store.updateEventStatus(event, EventConsumeStatus.PROCESSING);
                
                log('debug', `[Processor] Executing handler for event ${event.messageId}`);
                await match.handler(event);
                
                log('debug', `[Processor] Handler completed successfully for event ${event.messageId}`);
                if (this.config.store) await this.config.store.updateEventStatus(event, EventConsumeStatus.DONE);
                this.config.events?.onSuccess?.(event);
            };

            if (this.config.middleware?.length) {
                log('debug', `[Processor] Applying ${this.config.middleware.length} middleware(s) to event ${event.messageId}`);
                await applyMiddleware(this.config.middleware, event, runner);
            } else {
                await runner();
            }

            log('info', `[Processor] Successfully processed message ${event.messageId}`);

        } catch (err) {
            log('error', `[Processor] Error processing ${event.messageId}: ${(err as Error).message}`);
            
            const maxAttempts = this.config.retryQueue?.maxAttempts ?? 3;
            const currentAttempt = attempts + 1;

            log('debug', `[Processor] Current attempt: ${currentAttempt}/${maxAttempts} for message ${event.messageId}`);

            // Check if we've exceeded max attempts
            if (currentAttempt >= maxAttempts) {
                log('warn', `[Processor] Max attempts (${maxAttempts}) reached for message ${event.messageId}`);
                
                // Update status to ERROR in store
                if (this.config.store) {
                    log('debug', `[Processor] Updating event ${event.messageId} status to ERROR in store`);
                    await this.config.store.updateEventStatus(event, EventConsumeStatus.ERROR);
                }
                
                // Call error hook
                this.config.events?.onError?.(event, err as Error);
                
                // If DLQ is configured, send message to DLQ manually
                if (this.config.deadLetterQueue) {
                    log('info', `[Processor] Sending message ${event.messageId} to DLQ`);
                    
                    const dlqEvent: EventMessage = {
                        ...event,
                        // Set routing key if exchange is configured
                        routingKey: this.config.deadLetterQueue.exchange?.routingKey ?? event.routingKey,
                        properties: {
                            ...event.properties,
                            headers: {
                                ...event.properties?.headers,
                                'x-error-message': (err as Error).message,
                                'x-error-name': (err as Error).name,
                                'x-error-stack': (err as Error).stack || '',
                                'x-death-count': currentAttempt,
                                'x-death-reason': 'rejected',
                                'x-death-time': new Date().toISOString(),
                                'x-original-queue': this.config.consumeQueue.queue,
                                'x-first-death-reason': 'rejected',
                                'x-first-death-queue': this.config.consumeQueue.queue
                            }
                        }
                    };
                    
                    // Publish to DLQ using the same pattern as dlq-handler
                    await this.config.broker.publish(
                        this.config.deadLetterQueue.queue,
                        dlqEvent,
                        this.config.deadLetterQueue.exchange ? { exchange: this.config.deadLetterQueue.exchange } : undefined
                    );
                    
                    log('info', `[Processor] Message ${event.messageId} sent to DLQ successfully`);
                    // Don't throw error - message was handled by sending to DLQ
                    // This will cause the message to be ACK'd
                    return;
                }
                
                // No DLQ configured, re-throw the error
                log('info', `[Processor] Re-throwing error for message ${event.messageId} (no DLQ configured)`);
                throw err;
            } else {
                // Still have retries left
                log('info', `[Processor] Message ${event.messageId} will be retried (attempt ${currentAttempt}/${maxAttempts})`);
                
                // Update status to RETRY in store
                if (this.config.store) {
                    log('debug', `[Processor] Updating event ${event.messageId} status to RETRY in store`);
                    await this.config.store.updateEventStatus(event, EventConsumeStatus.RETRY);
                }
                
                // Call error hook
                this.config.events?.onError?.(event, err as Error);
                
                // Throw error to trigger nack and DLX routing to retry queue
                throw err;
            }
        }
    }
}
