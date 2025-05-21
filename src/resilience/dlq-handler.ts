import {EventMessage, ExchangeConfig, MessageQueue} from "../types";

export async function handleDLQ(
    dlq:
        | {
        queue: string;
        exchange?: ExchangeConfig;
    }
        | undefined,
    broker: MessageQueue,
    event: EventMessage
) {
    if (dlq?.queue && dlq.exchange) {
        console.warn(`[DLQ] Publishing event ${event.messageId} to DLQ ${dlq.queue}`);
        await broker.publish(dlq.queue, event, {exchange: dlq.exchange});
    } else {
        console.warn(`[DLQ] Event ${event.messageId} discarded (DLQ not configured)`);
    }
}
