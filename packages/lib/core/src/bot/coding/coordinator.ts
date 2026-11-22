import type {
    CodingDurableSession,
    CodingInstructionInput,
    CodingSessionCoordinator,
    CodingSessionCreateInput,
} from './types';
import { CodingSessionError } from './types';

export interface CodingSessionDurableStub {
    getState(userId: string, chatId: string): Promise<CodingDurableSession | null>;
    createSession(input: CodingSessionCreateInput): Promise<CodingDurableSession>;
    enqueueInstruction(input: CodingInstructionInput): Promise<CodingDurableSession>;
    stopSession(userId: string, chatId: string): Promise<CodingDurableSession | null>;
}

export interface CodingSessionNamespaceBinding {
    getByName(name: string): CodingSessionDurableStub;
}

export function codingSessionObjectName(userId: string, chatId: string): string {
    return `coding-${chatId}-${userId}`;
}

/** Thin client for the dedicated CodingSessionDurableObject. */
export class DurableCodingSessionCoordinator implements CodingSessionCoordinator {
    constructor(private readonly stub: CodingSessionDurableStub) {}

    getState(userId: string, chatId: string): Promise<CodingDurableSession | null> {
        return this.stub.getState(userId, chatId);
    }

    createSession(input: CodingSessionCreateInput): Promise<CodingDurableSession> {
        return this.stub.createSession(input);
    }

    enqueueInstruction(input: CodingInstructionInput): Promise<CodingDurableSession> {
        return this.stub.enqueueInstruction(input);
    }

    stopSession(userId: string, chatId: string): Promise<CodingDurableSession | null> {
        return this.stub.stopSession(userId, chatId);
    }
}

export function createDurableCodingSessionCoordinator(
    namespace: CodingSessionNamespaceBinding | null | undefined,
    userId: string,
    chatId: string,
): CodingSessionCoordinator {
    if (!namespace?.getByName) {
        throw new CodingSessionError('storage', 'CODING_SESSION Durable Object binding is not configured');
    }
    return new DurableCodingSessionCoordinator(namespace.getByName(codingSessionObjectName(userId, chatId)));
}
