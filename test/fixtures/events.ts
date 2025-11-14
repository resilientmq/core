import { EventMessage } from '../../src/types/resilience/event-message';
import { EventPublishStatus } from '../../src/types/enum/event-publish-status';

/**
 * Sample event payloads for different scenarios.
 */

export interface UserCreatedPayload {
    userId: string;
    email: string;
    name: string;
    createdAt: string;
}

export interface OrderPlacedPayload {
    orderId: string;
    userId: string;
    items: Array<{
        productId: string;
        quantity: number;
        price: number;
    }>;
    totalAmount: number;
    placedAt: string;
}

export interface PaymentProcessedPayload {
    paymentId: string;
    orderId: string;
    amount: number;
    currency: string;
    status: 'success' | 'failed' | 'pending';
    processedAt: string;
}

export interface NotificationSentPayload {
    notificationId: string;
    userId: string;
    type: 'email' | 'sms' | 'push';
    message: string;
    sentAt: string;
}

/**
 * Predefined event instances for testing.
 */

export const userCreatedEvent: EventMessage<UserCreatedPayload> = {
    messageId: 'user-created-001',
    type: 'user.created',
    payload: {
        userId: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        createdAt: new Date().toISOString()
    },
    status: EventPublishStatus.PENDING,
    routingKey: 'user.created',
    properties: {
        contentType: 'application/json',
        deliveryMode: 2,
        timestamp: Date.now()
    }
};

export const orderPlacedEvent: EventMessage<OrderPlacedPayload> = {
    messageId: 'order-placed-001',
    type: 'order.placed',
    payload: {
        orderId: 'order-456',
        userId: 'user-123',
        items: [
            { productId: 'prod-001', quantity: 2, price: 29.99 },
            { productId: 'prod-002', quantity: 1, price: 49.99 }
        ],
        totalAmount: 109.97,
        placedAt: new Date().toISOString()
    },
    status: EventPublishStatus.PENDING,
    routingKey: 'order.placed',
    properties: {
        contentType: 'application/json',
        deliveryMode: 2,
        timestamp: Date.now()
    }
};

export const paymentProcessedEvent: EventMessage<PaymentProcessedPayload> = {
    messageId: 'payment-processed-001',
    type: 'payment.processed',
    payload: {
        paymentId: 'pay-789',
        orderId: 'order-456',
        amount: 109.97,
        currency: 'USD',
        status: 'success',
        processedAt: new Date().toISOString()
    },
    status: EventPublishStatus.PENDING,
    routingKey: 'payment.processed',
    properties: {
        contentType: 'application/json',
        deliveryMode: 2,
        timestamp: Date.now(),
        correlationId: 'order-456'
    }
};

export const notificationSentEvent: EventMessage<NotificationSentPayload> = {
    messageId: 'notification-sent-001',
    type: 'notification.sent',
    payload: {
        notificationId: 'notif-999',
        userId: 'user-123',
        type: 'email',
        message: 'Your order has been confirmed',
        sentAt: new Date().toISOString()
    },
    status: EventPublishStatus.PENDING,
    routingKey: 'notification.sent',
    properties: {
        contentType: 'application/json',
        deliveryMode: 2,
        timestamp: Date.now()
    }
};

/**
 * Factory functions for creating test events with custom data.
 */

export function createUserCreatedEvent(overrides?: Partial<UserCreatedPayload>): EventMessage<UserCreatedPayload> {
    return {
        messageId: `user-created-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        type: 'user.created',
        payload: {
            userId: `user-${Math.random().toString(36).substring(7)}`,
            email: `test-${Math.random().toString(36).substring(7)}@example.com`,
            name: 'Test User',
            createdAt: new Date().toISOString(),
            ...overrides
        },
        status: EventPublishStatus.PENDING,
        routingKey: 'user.created',
        properties: {
            contentType: 'application/json',
            deliveryMode: 2,
            timestamp: Date.now()
        }
    };
}

export function createOrderPlacedEvent(overrides?: Partial<OrderPlacedPayload>): EventMessage<OrderPlacedPayload> {
    return {
        messageId: `order-placed-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        type: 'order.placed',
        payload: {
            orderId: `order-${Math.random().toString(36).substring(7)}`,
            userId: `user-${Math.random().toString(36).substring(7)}`,
            items: [
                { productId: 'prod-001', quantity: 1, price: 29.99 }
            ],
            totalAmount: 29.99,
            placedAt: new Date().toISOString(),
            ...overrides
        },
        status: EventPublishStatus.PENDING,
        routingKey: 'order.placed',
        properties: {
            contentType: 'application/json',
            deliveryMode: 2,
            timestamp: Date.now()
        }
    };
}

export function createPaymentProcessedEvent(overrides?: Partial<PaymentProcessedPayload>): EventMessage<PaymentProcessedPayload> {
    return {
        messageId: `payment-processed-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        type: 'payment.processed',
        payload: {
            paymentId: `pay-${Math.random().toString(36).substring(7)}`,
            orderId: `order-${Math.random().toString(36).substring(7)}`,
            amount: 100.00,
            currency: 'USD',
            status: 'success',
            processedAt: new Date().toISOString(),
            ...overrides
        },
        status: EventPublishStatus.PENDING,
        routingKey: 'payment.processed',
        properties: {
            contentType: 'application/json',
            deliveryMode: 2,
            timestamp: Date.now()
        }
    };
}

export function createNotificationSentEvent(overrides?: Partial<NotificationSentPayload>): EventMessage<NotificationSentPayload> {
    return {
        messageId: `notification-sent-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        type: 'notification.sent',
        payload: {
            notificationId: `notif-${Math.random().toString(36).substring(7)}`,
            userId: `user-${Math.random().toString(36).substring(7)}`,
            type: 'email',
            message: 'Test notification',
            sentAt: new Date().toISOString(),
            ...overrides
        },
        status: EventPublishStatus.PENDING,
        routingKey: 'notification.sent',
        properties: {
            contentType: 'application/json',
            deliveryMode: 2,
            timestamp: Date.now()
        }
    };
}

/**
 * Creates a generic test event with minimal data.
 */
export function createTestEvent<T = any>(payload?: T, type: string = 'test.event'): EventMessage<T> {
    return {
        messageId: `test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        type,
        payload: payload || {} as T,
        status: EventPublishStatus.PENDING,
        properties: {
            contentType: 'application/json',
            deliveryMode: 2,
            timestamp: Date.now()
        }
    };
}

/**
 * Creates a batch of test events for load testing.
 */
export function createTestEventBatch(count: number, type: string = 'test.event'): EventMessage[] {
    return Array.from({ length: count }, (_, i) => createTestEvent({ index: i }, type));
}
