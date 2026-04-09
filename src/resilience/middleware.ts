import { EventMessage, Middleware } from "../types";

export function applyMiddleware(
    middlewares: Middleware[],
    context: EventMessage,
    handler: () => Promise<void>
): Promise<void> {
    const compose = (index: number): Promise<void> => {
        if (index >= middlewares.length) {
            return handler();
        }
        return middlewares[index](context, () => compose(index + 1));
    };
    
    return compose(0);
}
