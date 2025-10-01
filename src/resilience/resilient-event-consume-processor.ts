import { handleDLQ } from './dlq-handler';
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
     * On error, it manages to retries or forwards the message to a DLQ if necessary.
     *
     * @param event - The incoming event message from the queue.
     */
    async process(event: EventMessage): Promise<void> {
        const deathHeaders = event.properties?.headers?.['x-death'];
        const attempts = deathHeaders && Array.isArray(deathHeaders) && deathHeaders.length > 0
            ? deathHeaders[0].count || 0
            : 0;

        try {
            const control = { skipEvent: false };
            this.config.events?.onEventStart?.(event, control);

            if (control.skipEvent) {
                log('info', `[Processor] Processing skipped by onEventStart for event ${event.messageId}`);
                return;
            }

            const existing = await this.config.store.getEvent(event);
            if (existing && attempts === 0) {
                log('warn', `[Processor] Duplicate event detected: ${event.messageId}`);
                return;
            } else if (existing) {
                await this.config.store.updateEventStatus(event, event.status as EventConsumeStatus);
            } else {
                await this.config.store.saveEvent(event);
            }

            const match = this.config.eventsToProcess.find(e => e.type === event.type);
            if (!match) {
                log('warn', `[Processor] No handler for event type: ${event.type}`);
                if (!this.config.ignoreUnknownEvents) {
                    await this.config.store.updateEventStatus(event, EventConsumeStatus.DONE);
                } else {
                    await this.config.store.deleteEvent(event);
                }
                return;
            }

            const runner = async () => {
                await this.config.store.updateEventStatus(event, EventConsumeStatus.PROCESSING);
                await match.handler(event.payload);
                await this.config.store.updateEventStatus(event, EventConsumeStatus.DONE);
                this.config.events?.onSuccess?.(event);
            };

            if (this.config.middleware?.length) {
                await applyMiddleware(this.config.middleware, event, runner,);
            } else {
                await runner();
            }

        } catch (err) {
            log('error', `[Processor] Error processing ${event.messageId}: ${(err as Error).message}`);
            await this.config.store.updateEventStatus(event, EventConsumeStatus.RETRY);

            const maxAttempts = this.config.retryQueue?.maxAttempts ?? 5;
            const currentAttempt = attempts + 1;

            log('info', `[Processor] Processing attempt ${currentAttempt}/${maxAttempts} for message ${event.messageId} (x-death count: ${attempts})`);

            if (currentAttempt > maxAttempts) {
                await handleDLQ(this.config.deadLetterQueue?.queue ? {
                    queue: this.config.deadLetterQueue?.queue,
                    exchange: this.config.deadLetterQueue?.exchange
                } : undefined, this.config.broker, event, err as Error, currentAttempt, this.config.consumeQueue.queue);
                await this.config.store.updateEventStatus(event, EventConsumeStatus.ERROR);
                log('warn', `[Processor] Sent message: ${event.messageId} to DLQ after ${attempts} retries`);
            } else {
                await this.config.store.updateEventStatus(event, EventConsumeStatus.RETRY);
                log('warn', `[Processor] Message ${event.messageId} will be retried automatically by RabbitMQ (attempt ${currentAttempt})`);

                throw err;
            }

            this.config.events?.onError?.(event, err as Error);
        }
    }
}
