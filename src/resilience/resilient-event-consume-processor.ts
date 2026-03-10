import { applyMiddleware } from './middleware';
import { log } from '../logger/logger';
import { EventConsumeStatus, EventMessage, RabbitMQResilientProcessorConfig } from "../types";

/**
 * Handles the lifecycle of consuming events, including retries, deduplication, and DLQ routing.
 *
 * Retry tracking uses a managed `x-retry-count` header instead of RabbitMQ's `x-death` to avoid
 * unreliable counting when multiple concurrent consumers race on the same retry queue.
 */
export class ResilientEventConsumeProcessor {
    private readonly config: RabbitMQResilientProcessorConfig;

    constructor(config: RabbitMQResilientProcessorConfig) {
        this.config = config;
    }

    /**
     * Extracts the current retry count from event headers.
     * Prefers `x-retry-count` (managed by us) over `x-death` (managed by RabbitMQ).
     * Falls back to `x-death[0].count` for backward compatibility with in-flight messages.
     *
     * @param event - The event to extract retry count from.
     * @returns The current retry count (0 means first attempt).
     */
    private getRetryCount(event: EventMessage): number {
        const headers = event.properties?.headers;
        if (!headers) return 0;

        // Prefer our managed header
        if (headers['x-retry-count'] != null) {
            const val = Number(headers['x-retry-count']);
            // Guard against NaN, negative, non-integer, or absurdly large values
            if (!Number.isFinite(val) || val < 0) return 0;
            return Math.floor(val);
        }

        // Fall back to x-death for backward compat with in-flight messages during upgrade
        const deathHeaders = headers['x-death'];
        if (Array.isArray(deathHeaders) && deathHeaders.length > 0) {
            const val = Number(deathHeaders[0].count || 0);
            if (!Number.isFinite(val) || val < 0) return 0;
            return Math.floor(val);
        }

        return 0;
    }

    /**
     * Sends a message to the DLQ if configured, or discards it.
     * Always returns (ACK) — never throws.
     *
     * @param event - The original event.
     * @param retryCount - Current retry count at the time of failure.
     * @param err - The error that caused the failure.
     */
    private async sendToDlqOrDiscard(event: EventMessage, retryCount: number, err: Error): Promise<void> {
        // Update status to ERROR in store
        if (this.config.store) {
            log('debug', `[Processor] Updating event ${event.messageId} status to ERROR in store`);
            await this.config.store.updateEventStatus(event, EventConsumeStatus.ERROR);
        }

        // Call error hook
        this.config.events?.onError?.(event, err);

        // If DLQ is configured, send message to DLQ manually
        if (this.config.deadLetterQueue) {
            log('info', `[Processor] Sending message ${event.messageId} to DLQ`);

            const reason = (err as any).reason || 'rejected';
            const dlqEvent: EventMessage = {
                ...event,
                routingKey: this.config.deadLetterQueue.exchange?.routingKey ?? event.routingKey,
                properties: {
                    ...event.properties,
                    headers: {
                        ...event.properties?.headers,
                        'x-error-message': err.message,
                        'x-error-name': err.name,
                        'x-error-stack': err.stack || '',
                        'x-death-count': retryCount,
                        'x-death-reason': reason,
                        'x-death-time': new Date().toISOString(),
                        'x-original-queue': this.config.consumeQueue.queue,
                        'x-first-death-reason': event.properties?.headers?.['x-first-death-reason'] || reason,
                        'x-first-death-queue': event.properties?.headers?.['x-first-death-queue'] || this.config.consumeQueue.queue
                    }
                }
            };

            await this.config.broker.publish(
                this.config.deadLetterQueue.queue,
                dlqEvent,
                this.config.deadLetterQueue.exchange ? { exchange: this.config.deadLetterQueue.exchange } : undefined
            );

            log('info', `[Processor] Message ${event.messageId} sent to DLQ successfully`);
            return;
        }

        // No DLQ configured — log and discard (ACK)
        log('warn', `[Processor] Message ${event.messageId} exceeded max retries with no DLQ configured, discarding`);
    }

    /**
     * Publishes the event to the retry queue with an incremented `x-retry-count` header.
     * Returns without throwing so the original message is ACK'd.
     *
     * @param event - The original event.
     * @param retryCount - The current retry count (will be incremented).
     */
    private async publishToRetryQueue(event: EventMessage, retryCount: number): Promise<void> {
        const retryQueue = this.config.retryQueue!;
        const nextRetryCount = retryCount + 1;
        const maxAttempts = retryQueue.maxAttempts ?? 3;
        log('warn', `[Processor] Retrying message ${event.messageId} (attempt ${nextRetryCount}/${maxAttempts})`);

        const retryEvent: EventMessage = {
            ...event,
            routingKey: retryQueue.exchange?.routingKey ?? event.routingKey,
            properties: {
                ...event.properties,
                headers: {
                    ...event.properties?.headers,
                    'x-retry-count': nextRetryCount,
                },
            },
        };

        await this.config.broker.publish(
            retryQueue.queue,
            retryEvent,
            retryQueue.exchange ? { exchange: retryQueue.exchange } : undefined
        );
    }

    /**
     * Processes an event message, applying middleware, storing metadata, and invoking a handler.
     * On error, it manages retries or forwards the message to a DLQ if necessary.
     *
     * Retry flow (concurrent-safe):
     * - Retries are tracked via a managed `x-retry-count` header.
     * - On failure: the processor publishes to the retry queue with an incremented count and ACKs.
     * - When `x-retry-count >= maxAttempts`: the message is routed to DLQ (or discarded) and ACKd.
     * - This avoids relying on RabbitMQ's `x-death` counter which is unreliable with concurrent consumers.
     *
     * @param event - The incoming event message from the queue.
     */
    async process(event: EventMessage): Promise<void> {
        const retryCount = this.getRetryCount(event);
        const maxAttempts = this.config.retryQueue?.maxAttempts ?? 3;

        // Hard guard: if already at or past the limit, route to DLQ immediately (never process)
        if (retryCount >= maxAttempts) {
            log('warn', `[Processor] Message ${event.messageId} exceeded max retries (${retryCount}/${maxAttempts}), routing to DLQ`);
            await this.sendToDlqOrDiscard(event, retryCount, new Error(`Max retry attempts (${maxAttempts}) exceeded`));
            return;
        }

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

            const match = this.config.eventsToProcess.find(e => e.type === event.type);
            if (match) log('info', `[Processor] Start to processing message ${event.messageId} (type: ${event.type}, attempt: ${retryCount + 1})`);

            if (existing && retryCount === 0) {
                log('warn', `[Processor] Duplicate event detected: ${event.messageId}, skipping`);
                return;
            } else if (existing) {
                log('debug', `[Processor] Updating existing event ${event.messageId} status in store`);
                if (this.config.store) await this.config.store.updateEventStatus(event, event.status as EventConsumeStatus);
            } else if (match || !this.config.ignoreUnknownEvents) {
                log('debug', `[Processor] Saving new event ${event.messageId} to store`);
                if (this.config.store) await this.config.store.saveEvent(event);
            }

            if (!match) {
                log('debug', `[Processor] No handler for event type: ${event.type}`);
                if (!this.config.ignoreUnknownEvents && this.config.store) await this.config.store.updateEventStatus(event, EventConsumeStatus.DONE);
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

            // Safety wrapper: ANY failure in retry/DLQ logic must NOT propagate.
            // If we throw here, amqp-queue nacks the message → DLX → retry queue
            // without incrementing x-retry-count → infinite loop.
            try {
                const currentAttempt = retryCount + 1;

                log('debug', `[Processor] Current attempt: ${currentAttempt}/${maxAttempts} for message ${event.messageId}`);

                // Check if we've exceeded max attempts
                if (currentAttempt >= maxAttempts) {
                    log('warn', `[Processor] Max attempts (${maxAttempts}) reached for message ${event.messageId}`);
                    await this.sendToDlqOrDiscard(event, currentAttempt, err as Error);
                    return;
                }

                // Still have retries left — manually publish to retry queue with incremented counter
                if (this.config.store) {
                    log('debug', `[Processor] Updating event ${event.messageId} status to RETRY in store`);
                    await this.config.store.updateEventStatus(event, EventConsumeStatus.RETRY);
                }

                // Call error hook
                this.config.events?.onError?.(event, err as Error);

                if (this.config.retryQueue) {
                    // Publish to retry queue and return (ACK the original)
                    await this.publishToRetryQueue(event, retryCount);
                } else {
                    // No retry queue configured — route to DLQ or discard (never throw)
                    log('warn', `[Processor] No retry queue configured for message ${event.messageId}, routing to DLQ or discarding`);
                    await this.sendToDlqOrDiscard(event, currentAttempt, err as Error);
                }
                // Don't throw — the message is ACK'd
            } catch (internalErr) {
                // CRITICAL SAFETY NET: If retry/DLQ publishing itself fails,
                // we MUST NOT throw — that would nack the message and create a loop.
                // Log the error and let the message be ACK'd (lost, but no loop).
                log('error', `[Processor] CRITICAL: Failed to handle error for message ${event.messageId}. ` +
                    `Message will be ACK'd to prevent infinite loop. ` +
                    `Original error: ${(err as Error).message}. ` +
                    `Internal error: ${(internalErr as Error).message}`);
            }
        }
    }
}
