export type CodingSessionStatus = 'initializing' | 'awaiting_input' | 'running';

export type CodingJobStatus =
    | 'queued'
    | 'running'
    | 'awaiting_input'
    | 'cancelling'
    | 'cancelled'
    | 'completed'
    | 'failed';

export type CodingJobKind = 'checkout' | 'instruction';

export interface CodingTelegramTarget {
    chatId: number;
    messageId?: number;
}

export interface CodingJobState {
    id: string;
    kind: CodingJobKind;
    status: CodingJobStatus;
    instruction?: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    progress?: string;
    error?: string;
    cancelRequestedAt?: number;
    cancelledAt?: number;
    telegramMessageId?: number;
    heartbeatAt?: number;
}

/**
 * Authoritative state owned by CodingSessionDurableObject. One object exists
 * per Telegram user/chat and holds the current or most recent coding session.
 */
export interface CodingDurableSession {
    version: 2;
    sessionId: string;
    userId: string;
    chatId: string;
    repository: string;
    status: CodingJobStatus;
    cancellationRequested: boolean;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    job: CodingJobState | null;
}

export interface CodingSessionCreateInput {
    userId: string;
    chatId: string;
    repository: string;
    telegram?: CodingTelegramTarget;
}

export interface CodingInstructionInput {
    userId: string;
    chatId: string;
    instruction: string;
    telegram?: CodingTelegramTarget;
}

/** Client-side contract for the dedicated coding-session Durable Object. */
export interface CodingSessionCoordinator {
    getState(userId: string, chatId: string): Promise<CodingDurableSession | null>;
    createSession(input: CodingSessionCreateInput): Promise<CodingDurableSession>;
    enqueueInstruction(input: CodingInstructionInput): Promise<CodingDurableSession>;
    stopSession(userId: string, chatId: string): Promise<CodingDurableSession | null>;
}

export type CodingCoordinatorFactory = (userId: string, chatId: string) => CodingSessionCoordinator;

export interface CodingSessionState {
    version: 1;
    sessionId: string;
    userId: string;
    chatId: string;
    repository: string;
    status: CodingSessionStatus;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
}

export type CodingErrorCode =
    | 'active'
    | 'unauthorized'
    | 'sandbox'
    | 'checkout'
    | 'agent'
    | 'cancelled'
    | 'expired'
    | 'not-found'
    | 'busy'
    | 'invalid'
    | 'storage';

export class CodingSessionError extends Error {
    readonly name = 'CodingSessionError';

    constructor(
        public readonly code: CodingErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
    }
}

export interface CodingRunResult {
    text: string;
    steps: number;
    stopReason: 'complete' | 'max-steps';
}

export function codingErrorMessage(error: unknown): string {
    if (error instanceof CodingSessionError) {
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
