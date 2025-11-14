/**
 * Sample payloads for different event types and testing scenarios.
 */

/**
 * Small payload (~100 bytes) for basic testing.
 */
export const smallPayload = {
    id: '123',
    name: 'Test',
    value: 42
};

/**
 * Medium payload (~1KB) for typical message testing.
 */
export const mediumPayload = {
    id: 'med-001',
    timestamp: new Date().toISOString(),
    user: {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        roles: ['user', 'admin']
    },
    metadata: {
        source: 'test-suite',
        version: '1.0.0',
        environment: 'test'
    },
    data: {
        field1: 'value1',
        field2: 'value2',
        field3: 'value3',
        field4: 'value4',
        field5: 'value5'
    },
    tags: ['test', 'automated', 'integration'],
    description: 'This is a medium-sized payload for testing typical message scenarios'
};

/**
 * Large payload (~10KB) for stress testing.
 */
export const largePayload = {
    id: 'large-001',
    timestamp: new Date().toISOString(),
    items: Array.from({ length: 100 }, (_, i) => ({
        id: `item-${i}`,
        name: `Item ${i}`,
        description: `This is a detailed description for item ${i} with additional text to increase payload size`,
        price: Math.random() * 1000,
        quantity: Math.floor(Math.random() * 100),
        metadata: {
            category: `category-${i % 10}`,
            tags: [`tag-${i}`, `tag-${i + 1}`, `tag-${i + 2}`],
            attributes: {
                color: 'blue',
                size: 'medium',
                weight: Math.random() * 10
            }
        }
    })),
    summary: {
        totalItems: 100,
        totalValue: 50000,
        averagePrice: 500
    }
};

/**
 * Very large payload (~100KB) for extreme stress testing.
 */
export const veryLargePayload = {
    id: 'very-large-001',
    timestamp: new Date().toISOString(),
    data: Array.from({ length: 1000 }, (_, i) => ({
        index: i,
        uuid: `${i}-${Math.random().toString(36).substring(7)}`,
        content: `This is content block ${i} with additional text to make the payload larger. `.repeat(10),
        nested: {
            level1: {
                level2: {
                    level3: {
                        value: `nested-value-${i}`
                    }
                }
            }
        }
    }))
};

/**
 * Payload with special characters for encoding testing.
 */
export const specialCharsPayload = {
    id: 'special-001',
    text: 'Special characters: áéíóú ñ ü ç € £ ¥ © ® ™ • ° ± × ÷',
    emoji: '😀 🎉 🚀 ✨ 💡 🔥 ⚡ 🌟',
    unicode: '\u0048\u0065\u006C\u006C\u006F',
    escaped: 'Line 1\nLine 2\tTabbed\r\nWindows line',
    quotes: "Single 'quotes' and double \"quotes\"",
    backslash: 'Path: C:\\Users\\Test\\file.txt'
};

/**
 * Payload with nested objects for complex data testing.
 */
export const nestedPayload = {
    level1: {
        id: 'l1',
        level2: {
            id: 'l2',
            level3: {
                id: 'l3',
                level4: {
                    id: 'l4',
                    level5: {
                        id: 'l5',
                        data: 'deeply nested value'
                    }
                }
            }
        }
    },
    arrays: {
        simple: [1, 2, 3, 4, 5],
        nested: [[1, 2], [3, 4], [5, 6]],
        objects: [
            { id: 1, name: 'First' },
            { id: 2, name: 'Second' },
            { id: 3, name: 'Third' }
        ]
    }
};

/**
 * Payload with various data types for type handling testing.
 */
export const mixedTypesPayload = {
    string: 'text value',
    number: 42,
    float: 3.14159,
    boolean: true,
    null: null,
    undefined: undefined,
    date: new Date().toISOString(),
    array: [1, 'two', true, null],
    object: { key: 'value' },
    emptyString: '',
    emptyArray: [],
    emptyObject: {}
};

/**
 * Minimal payload for performance testing.
 */
export const minimalPayload = {
    id: '1'
};

/**
 * Payload simulating a real-world user event.
 */
export const userEventPayload = {
    userId: 'user-12345',
    action: 'login',
    timestamp: new Date().toISOString(),
    ipAddress: '192.168.1.100',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    sessionId: 'session-abc123',
    metadata: {
        previousLogin: new Date(Date.now() - 86400000).toISOString(),
        loginCount: 42,
        accountAge: 365
    }
};

/**
 * Payload simulating a real-world order event.
 */
export const orderEventPayload = {
    orderId: 'order-67890',
    customerId: 'customer-12345',
    items: [
        {
            productId: 'prod-001',
            name: 'Product 1',
            quantity: 2,
            unitPrice: 29.99,
            totalPrice: 59.98
        },
        {
            productId: 'prod-002',
            name: 'Product 2',
            quantity: 1,
            unitPrice: 49.99,
            totalPrice: 49.99
        }
    ],
    subtotal: 109.97,
    tax: 9.90,
    shipping: 5.00,
    total: 124.87,
    currency: 'USD',
    status: 'pending',
    createdAt: new Date().toISOString(),
    shippingAddress: {
        street: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        zipCode: '12345',
        country: 'USA'
    }
};

/**
 * Factory function to create a payload of specific size.
 * @param sizeInBytes Approximate size in bytes
 * @returns Payload object
 */
export function createPayloadOfSize(sizeInBytes: number): any {
    const baseSize = 50; // Approximate overhead
    const textLength = Math.max(0, sizeInBytes - baseSize);
    const text = 'x'.repeat(textLength);
    
    return {
        id: 'size-test',
        data: text
    };
}

/**
 * Factory function to create a batch of similar payloads.
 * @param count Number of payloads to create
 * @param template Template payload to use
 * @returns Array of payloads
 */
export function createPayloadBatch(count: number, template: any = smallPayload): any[] {
    return Array.from({ length: count }, (_, i) => ({
        ...template,
        id: `${template.id}-${i}`,
        index: i
    }));
}
