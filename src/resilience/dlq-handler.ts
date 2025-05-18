import type {EventMessage, ExchangeConfig, MessageQueue} from "@resilientmq/types__core";

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
        console.warn(`[DLQ] Publishing event ${event.id} to DLQ ${dlq.queue}`);
        await broker.publish(dlq.queue, event, {exchange: dlq.exchange});
    } else {
        console.warn(`[DLQ] Event ${event.id} discarded (DLQ not configured)`);
    }
}
