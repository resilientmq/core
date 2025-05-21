import { handleDLQ } from './dlq-handler';
import { applyMiddleware } from './middleware';
import { log } from '../logger/logger';
import {EventConsumeStatus, EventMessage, RabbitMQResilientProcessorConfig} from "../types";

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
        try {
            this.config.events?.onEventStart?.(event);

            const existing = await this.config.store.getEvent(event);
            if (existing) {
                log('warn', `[Processor] Duplicate event detected: ${event.messageId}`);
                return;
            }

            await this.config.store.saveEvent(event);

            const match = this.config.eventsToProcess.find(e => e.type === event.type);
            if (!match) {
                log('warn', `[Processor] No handler for event type: ${event.type}`);
                return;
            }

            const runner = async () => {
                await this.config.store.updateEventStatus(event, EventConsumeStatus.PROCESSING);
                await match.handler(event.payload);
                await this.config.store.updateEventStatus(event, EventConsumeStatus.DONE);
                this.config.events?.onSuccess?.(event);
            };

            if (this.config.middleware?.length) {
                await applyMiddleware(this.config.middleware, event, runner, );
            } else {
                await runner();
            }

        } catch (err) {
            log('error', `[Processor] Error processing ${event.messageId}: ${(err as Error).message}`);
            await this.config.store.updateEventStatus(event, EventConsumeStatus.RETRY);

            const attempts = event.properties?.headers?.['x-attempts'] ?? 0;
            const maxAttempts = this.config.retryQueue?.maxAttempts ?? 5;

            const updatedEvent: EventMessage = {
                ...event,
                properties: {
                    ...event.properties,
                    headers: {
                        ...event.properties?.headers,
                        'x-attempts': attempts + 1
                    }
                }
            };

            if (attempts + 1 >= maxAttempts) {
                await this.config.store.updateEventStatus(event, EventConsumeStatus.ERROR);
                await handleDLQ({queue: this.config.consumeQueue.queue, exchange: this.config.consumeQueue.exchange},this.config.broker, updatedEvent);
                log('warn', `[Processor] Sent to DLQ after ${attempts + 1} attempts: ${event.messageId}`);
            } else if (this.config.retryQueue?.queue) {
                await this.config.broker.publish(this.config.retryQueue.queue, updatedEvent, {
                    exchange: this.config.retryQueue.exchange
                });
                log('warn', `[Processor] Retrying message ${event.messageId}, attempt ${attempts + 1}`);
            }

            this.config.events?.onError?.(event, err as Error);
        }
    }
}
