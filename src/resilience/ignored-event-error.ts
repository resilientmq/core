export class IgnoredEventError extends Error {
    constructor(message?: string) {
        super(message || 'Event ignored by business logic');
        this.name = 'IgnoredEventError';
    }
}

