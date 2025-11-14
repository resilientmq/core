import {EventMessage, ExchangeConfig, MessageQueue} from "../types";
import {log} from "../logger/logger";

export async function handleDLQ(
    dlq:
        | {
        queue: string;
        exchange?: ExchangeConfig;
    }
        | undefined,
    broker: MessageQueue,
    event: EventMessage,
    error?: Error,
    attempts?: number,
    originalQueue?: string
) {
    if (dlq?.queue && dlq.exchange) {
        log('warn', `[DLQ] Sending message ${event.messageId} to dead letter queue`);

        // Crear headers con información del error similar a RabbitMQ
        const errorHeaders = {
            'x-first-death-exchange': event.properties?.headers?.['x-first-death-exchange'] || event.properties?.headers?.['x-original-exchange'] || '',
            'x-first-death-queue': event.properties?.headers?.['x-first-death-queue'] || originalQueue || '',
            'x-first-death-routing-key': event.properties?.headers?.['x-first-death-routing-key'] || event.properties?.headers?.['x-original-routing-key'] || '',
            'x-first-death-reason': 'rejected',
            'x-death-reason': error ? 'rejected' : 'expired',
            'x-death-count': attempts || 1,
            'x-death-time': new Date().toISOString(),
            'x-original-exchange': event.properties?.headers?.['x-original-exchange'] || '',
            'x-original-routing-key': event.properties?.headers?.['x-original-routing-key'] || '',
            'x-original-queue': originalQueue || '',
        } as any;

        // Agregar información detallada del error si existe
        if (error) {
            errorHeaders['x-error-message'] = error.message;
            errorHeaders['x-error-name'] = error.name;
            errorHeaders['x-error-stack'] = error.stack || '';
        }

        // Crear el evento con los headers actualizados
        const dlqEvent: EventMessage = {
            ...event,
            properties: {
                ...event.properties,
                headers: {
                    ...event.properties?.headers,
                    ...errorHeaders
                }
            }
        };

        await broker.publish(dlq.queue, dlqEvent, {exchange: dlq.exchange});
        log('debug', `[DLQ] Message ${event.messageId} sent to DLQ successfully`);
    } else {
        log('warn', `[DLQ] Message ${event.messageId} discarded (DLQ not configured)`);
    }
}
