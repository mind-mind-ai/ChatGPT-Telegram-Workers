export type CodingSessionStatus = 'initializing' | 'awaiting_input' | 'running';

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
    | 'invalid';

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
