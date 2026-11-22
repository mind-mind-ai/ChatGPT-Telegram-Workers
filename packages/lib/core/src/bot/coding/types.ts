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

export type CodingChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface CodingChangeFile {
    path: string;
    previousPath?: string;
    status: CodingChangeStatus;
    sha256: string;
    size: number;
    additions: number;
    deletions: number;
    binary?: boolean;
    /** Base64 content for added, modified and renamed files. */
    contentBase64?: string;
}

export interface CodingChangeSet {
    repository: string;
    baseRef: string;
    baseCommitSha: string;
    diffHash: string;
    diff: string;
    files: CodingChangeFile[];
    summary: string;
    createdAt: number;
}

export type CodingApprovalStatus =
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'applying'
    | 'completed'
    | 'failed'
    | 'stale';

export interface CodingApprovalState {
    id: string;
    nonce: string;
    status: CodingApprovalStatus;
    sessionId: string;
    jobId: string;
    userId: string;
    chatId: string;
    diffHash: string;
    changeKey: string;
    createdAt: number;
    expiresAt: number;
    telegramMessageId?: number;
    approvedAt?: number;
    applyingAt?: number;
    rejectedAt?: number;
    expiredAt?: number;
    staleAt?: number;
    completedAt?: number;
    failedAt?: number;
    branch?: string;
    commitSha?: string;
    error?: string;
}

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
    baseRef?: string;
    baseCommitSha?: string;
    approval?: CodingApprovalState | null;
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
export interface CodingApprovalRequest {
    userId: string;
    chatId: string;
    approvalId: string;
    nonce: string;
}

export interface CodingApprovalReview {
    approval: CodingApprovalState;
    changeSet?: CodingChangeSet;
}

export interface CodingApprovalResult {
    approval: CodingApprovalState;
    branch?: string;
    commitSha?: string;
}

export interface CodingSessionCoordinator {
    getState(userId: string, chatId: string): Promise<CodingDurableSession | null>;
    createSession(input: CodingSessionCreateInput): Promise<CodingDurableSession>;
    enqueueInstruction(input: CodingInstructionInput): Promise<CodingDurableSession>;
    stopSession(userId: string, chatId: string): Promise<CodingDurableSession | null>;
    reviewApproval(input: CodingApprovalRequest): Promise<CodingApprovalReview>;
    approveChanges(input: CodingApprovalRequest): Promise<CodingApprovalResult>;
    rejectChanges(input: CodingApprovalRequest): Promise<CodingApprovalResult>;
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
    | 'storage'
    | 'stale'
    | 'limit';

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

export type CodingApprovalAction = 'review' | 'approve' | 'reject';

export function codingApprovalCallbackData(action: CodingApprovalAction, approvalId: string, nonce: string): string {
    return `code:approval:${action}:${approvalId}:${nonce}`;
}

export function parseCodingApprovalCallbackData(
    data: string,
): { action: CodingApprovalAction; approvalId: string; nonce: string } | null {
    const match = /^code:approval:(review|approve|reject):([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]{1,32})$/.exec(data);
    if (!match) {
        return null;
    }
    return {
        action: match[1] as CodingApprovalAction,
        approvalId: match[2],
        nonce: match[3],
    };
}
