import {EventConsumeStatus} from '../../../src/types';
import {EventStoreMock} from '../../utils/event-store-mock';

describe('EventStore lease fencing contract', () => {
    it('lets a new replica recover an expired claim and rejects the stale completion', async () => {
        const store = new EventStoreMock();
        const event = {messageId: 'lease', type: 'known', payload: {}};
        const first = await store.claimConsumeEvent({
            event,
            serviceId: 'service',
            instanceId: 'dead-instance',
            attempt: 1,
            leaseDurationMs: 10,
            now: 0
        });
        const second = await store.claimConsumeEvent({
            event,
            serviceId: 'service',
            instanceId: 'replacement',
            attempt: 2,
            leaseDurationMs: 10,
            now: 11
        });
        expect(first.outcome).toBe('acquired');
        expect(second.outcome).toBe('acquired');
        if (first.outcome !== 'acquired' || second.outcome !== 'acquired') throw new Error('Claims not acquired');
        await expect(store.transitionConsumeEvent({
            event,
            serviceId: 'service',
            instanceId: 'dead-instance',
            fencingToken: first.fencingToken,
            status: EventConsumeStatus.DONE,
            now: 12
        })).resolves.toBe(false);
        await expect(store.transitionConsumeEvent({
            event,
            serviceId: 'service',
            instanceId: 'replacement',
            fencingToken: second.fencingToken,
            status: EventConsumeStatus.DONE,
            now: 12
        })).resolves.toBe(true);
    });
});
