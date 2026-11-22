import { describe, expect, it, vi } from 'vitest';
import {
    codingSessionObjectName,
    createDurableCodingSessionCoordinator,
    type CodingSessionDurableStub,
    type CodingSessionNamespaceBinding,
} from './coordinator';
import { durableSession } from './test-helpers';

describe('DurableCodingSessionCoordinator', () => {
    it('uses one stable object name per user and chat', () => {
        expect(codingSessionObjectName('10', '10')).toBe('coding-10-10');
        expect(codingSessionObjectName('11', '10')).not.toBe(codingSessionObjectName('10', '10'));
    });

    it('forwards calls to the Durable Object stub', async () => {
        const session = durableSession();
        const stub: CodingSessionDurableStub = {
            getState: vi.fn(async () => session),
            createSession: vi.fn(async () => session),
            enqueueInstruction: vi.fn(async () => session),
            stopSession: vi.fn(async () => session),
        };
        const namespace: CodingSessionNamespaceBinding = { getByName: vi.fn(() => stub) };
        const coordinator = createDurableCodingSessionCoordinator(namespace, '10', '10');
        await coordinator.getState('10', '10');
        await coordinator.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await coordinator.enqueueInstruction({ userId: '10', chatId: '10', instruction: 'work' });
        await coordinator.stopSession('10', '10');
        expect(namespace.getByName).toHaveBeenCalledWith('coding-10-10');
        expect(stub.getState).toHaveBeenCalledWith('10', '10');
        expect(stub.createSession).toHaveBeenCalled();
        expect(stub.enqueueInstruction).toHaveBeenCalled();
        expect(stub.stopSession).toHaveBeenCalledWith('10', '10');
    });

    it('fails safely when the binding is missing', () => {
        expect(() => createDurableCodingSessionCoordinator(null, '10', '10')).toThrow(/CODING_SESSION/);
    });
});
