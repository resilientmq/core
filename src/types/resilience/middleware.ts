import type { EventMessage } from './event-message';

/**
 * A middleware function used to extend or intercept the behavior of event handling.
 *
 * It is invoked before the actual event handler and can perform cross-cutting concerns
 * like logging, retries, validation, or authentication.
 *
 * @param event - The event being processed.
 * @param next - Callback to proceed to the next middleware or final handler.
 */
export type Middleware = (
    event: EventMessage,
    next: () => Promise<void>
) => Promise<void>;
