import type { EventMessage, Middleware } from "@resilientmq/types__core";

export function applyMiddleware(
    middlewares: Middleware[],
    context: EventMessage,
    handler: () => Promise<void>
): Promise<void> {
    const compose = (mw: Middleware[], ctx: EventMessage, next: () => Promise<void>): Promise<void> => {
        if (mw.length === 0) return next();
        const [first, ...rest] = mw;
        return first(ctx, () => compose(rest, ctx, next));
    };
    return compose(middlewares, context, handler);
}
