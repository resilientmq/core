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
        const attempts = event.properties?.headers?.['x-death']?.[0]?.count;
        try {
            const control = { skipEvent: false };
            this.config.events?.onEventStart?.(event, control);

            if (control.skipEvent) {
                log('info', `[Processor] Processing skipped by onEventStart for event ${event.messageId}`);
                return;
            }
            const existing = await this.config.store.getEvent(event);
            if (existing && !attempts) {
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
            const actualAttemp = attempts ?? 1
            if (!maxAttempts || actualAttemp > maxAttempts) {
                await handleDLQ({
                    queue: this.config.consumeQueue.queue,
                    exchange: this.config.consumeQueue.exchange
                }, this.config.broker, event);
                await this.config.store.updateEventStatus(event, EventConsumeStatus.ERROR);
                log('warn', `[Processor] Sent message: ${event.messageId} to DLQ after ${actualAttemp} attempts`);
            } else if (this.config.retryQueue?.queue) {
                await this.config.store.updateEventStatus(event, EventConsumeStatus.RETRY);
                await this.config.broker.publish(this.config.retryQueue.queue, event, {
                    exchange: this.config.retryQueue.exchange
                });
                log('warn', `[Processor] Retrying message ${event.messageId}, attempt ${actualAttemp}`);
            }

            this.config.events?.onError?.(event, err as Error);
        }
    }
}
