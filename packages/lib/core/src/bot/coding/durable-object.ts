import { createGitHubServiceFromEnv, loadChatLLM } from '@chatgpt-telegram-workers/agent';
import { ENV } from '@chatgpt-telegram-workers/config';
import { createDurableObjectSandboxClient, type SandboxNamespaceBinding } from '@chatgpt-telegram-workers/sandbox';
import { CodingAgentExecutor, type CodingWorkspaceSession } from './executor';
import { CodingChangeStore, CodingHistoryStore } from './history';
import { CodingTelegramNotifier, type CodingJobNotifier } from './notifier';
import type * as Telegram from 'telegram-bot-api-types';
import {
    CodingSessionError,
    codingErrorMessage,
    codingApprovalCallbackData,
    type CodingApprovalAction,
    type CodingApprovalRequest,
    type CodingApprovalResult,
    type CodingApprovalReview,
    type CodingApprovalState,
    type CodingApprovalStatus,
    type CodingChangeSet,
    type CodingDurableSession,
    type CodingInstructionInput,
    type CodingJobState,
    type CodingJobStatus,
    type CodingSessionCreateInput,
    type CodingTelegramTarget,
} from './types';

const STATE_KEY = 'coding-session';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACTIVE_STATUSES: readonly CodingJobStatus[] = ['queued', 'running', 'awaiting_input', 'cancelling'];
const TERMINAL_STATUSES: readonly CodingJobStatus[] = ['cancelled', 'completed', 'failed'];
const APPROVAL_STATUSES: readonly CodingApprovalStatus[] = [
    'pending',
    'approved',
    'rejected',
    'expired',
    'applying',
    'completed',
    'failed',
    'stale',
];
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_CANCEL_WAIT_MS = 8_000;
const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
const APPROVAL_DIFF_MESSAGE_LIMIT = 3_500;
const MAX_INSTRUCTION_CHARS = 20_000;
const MAX_ERROR_CHARS = 2_000;

// Shared by all simulated DO instances in tests; production has one instance.
const storageLocks = new WeakMap<object, Promise<void>>();

export interface CodingSessionDurableStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(time: number): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
}

export interface CodingSessionDurableContext {
    storage: CodingSessionDurableStorage;
    waitUntil?(promise: Promise<unknown>): void;
}

export interface CodingSessionDurableEnv {
    TELEGRAM_TOKEN?: string;
    SANDBOX?: unknown;
    DATABASE?: unknown;
    GITHUB_ALLOWED_REPOSITORIES?: string;
    GITHUB_ALLOWED_REPOSITORIES_BY_USER?: string;
    GITHUB_WRITE_ALLOWED_REPOSITORIES?: string;
    GITHUB_INSTALLATION_ID?: string;
    GITHUB_INSTALLATION_IDS?: string;
    GITHUB_APP_ID?: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    GITHUB_API_BASE_URL?: string;
    CODING_APPROVAL_TTL_MS?: string;
    [key: string]: unknown;
}

export interface CodingSessionDurableObjectOptions {
    executor?: CodingAgentExecutor;
    history?: CodingHistoryStore;
    changes?: CodingChangeStore;
    notifier?: CodingJobNotifier;
    now?: () => number;
    idFactory?: () => string;
    ttlMs?: number;
    heartbeatMs?: number;
    staleMs?: number;
    cancelWaitMs?: number;
    approvalTtlMs?: number;
    configLoader?: () => Promise<void>;
}

interface ActiveJob {
    jobId: string;
    controller: AbortController;
    promise: Promise<void>;
}

interface CodingJobOutcome {
    text: string;
    changeSet?: CodingChangeSet | null;
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function safeError(error: unknown): string {
    return codingErrorMessage(error).slice(0, MAX_ERROR_CHARS);
}

function isActive(status: CodingJobStatus): boolean {
    return ACTIVE_STATUSES.includes(status);
}

function isValidJob(value: unknown): value is CodingJobState {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const job = value as Partial<CodingJobState>;
    return (
        typeof job.id === 'string' &&
        (job.kind === 'checkout' || job.kind === 'instruction') &&
        typeof job.status === 'string' &&
        ACTIVE_STATUSES.concat(TERMINAL_STATUSES).includes(job.status as CodingJobStatus) &&
        typeof job.createdAt === 'number' &&
        Number.isFinite(job.createdAt)
    );
}

function isValidApproval(value: unknown): value is CodingApprovalState {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const approval = value as Partial<CodingApprovalState>;
    return (
        typeof approval.id === 'string' &&
        SESSION_ID_PATTERN.test(approval.id) &&
        typeof approval.nonce === 'string' &&
        SESSION_ID_PATTERN.test(approval.nonce) &&
        typeof approval.status === 'string' &&
        APPROVAL_STATUSES.includes(approval.status as CodingApprovalStatus) &&
        typeof approval.sessionId === 'string' &&
        typeof approval.jobId === 'string' &&
        typeof approval.userId === 'string' &&
        typeof approval.chatId === 'string' &&
        typeof approval.diffHash === 'string' &&
        /^[0-9a-f]{64}$/i.test(approval.diffHash) &&
        typeof approval.changeKey === 'string' &&
        typeof approval.createdAt === 'number' &&
        typeof approval.expiresAt === 'number'
    );
}

function isValidState(value: unknown): value is CodingDurableSession {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const state = value as Partial<CodingDurableSession>;
    return (
        state.version === 2 &&
        typeof state.sessionId === 'string' &&
        SESSION_ID_PATTERN.test(state.sessionId) &&
        typeof state.userId === 'string' &&
        USER_ID_PATTERN.test(state.userId) &&
        typeof state.chatId === 'string' &&
        USER_ID_PATTERN.test(state.chatId) &&
        typeof state.repository === 'string' &&
        REPOSITORY_PATTERN.test(state.repository) &&
        typeof state.status === 'string' &&
        ACTIVE_STATUSES.concat(TERMINAL_STATUSES).includes(state.status as CodingJobStatus) &&
        typeof state.cancellationRequested === 'boolean' &&
        typeof state.expiresAt === 'number' &&
        Number.isFinite(state.expiresAt) &&
        (state.job === null || isValidJob(state.job)) &&
        (state.baseRef === undefined || typeof state.baseRef === 'string') &&
        (state.baseCommitSha === undefined || typeof state.baseCommitSha === 'string') &&
        (state.approval === undefined || state.approval === null || isValidApproval(state.approval))
    );
}

export function createCodingAgentExecutorFromEnv(env: CodingSessionDurableEnv): CodingAgentExecutor {
    return new CodingAgentExecutor({
        sandboxFactory: scope => createDurableObjectSandboxClient(env.SANDBOX as SandboxNamespaceBinding | null, scope),
        githubFactory: () => createGitHubServiceFromEnv(env),
        agentFactory: () => loadChatLLM(ENV.CONFIG),
    });
}

/**
 * One authoritative Durable Object per Telegram user/chat. It serializes
 * session operations, owns job state and executes background jobs through
 * alarms. A job never writes its result unless it is still the current
 * session and job.
 */
export class CodingSessionDurableObject {
    private readonly executor: CodingAgentExecutor;
    private readonly history: CodingHistoryStore;
    private readonly changes: CodingChangeStore;
    private readonly notifier: CodingJobNotifier;
    private readonly now: () => number;
    private readonly idFactory: () => string;
    private readonly ttlMs: number;
    private readonly heartbeatMs: number;
    private readonly staleMs: number;
    private readonly cancelWaitMs: number;
    private readonly approvalTtlMs: number;
    private readonly configLoader: () => Promise<void>;
    private activeJob: ActiveJob | null = null;
    private operationQueue: Promise<void> = Promise.resolve();
    private readonly startingJobs = new Set<string>();

    constructor(
        private readonly ctx: CodingSessionDurableContext,
        private readonly env: CodingSessionDurableEnv,
        options: CodingSessionDurableObjectOptions = {},
    ) {
        this.executor = options.executor ?? createCodingAgentExecutorFromEnv(env);
        this.history = options.history ?? new CodingHistoryStore(env.DATABASE as never);
        this.notifier = options.notifier ?? new CodingTelegramNotifier(env.TELEGRAM_TOKEN);
        this.now = options.now ?? Date.now;
        this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
        this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
        this.cancelWaitMs = options.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS;
        this.approvalTtlMs = options.approvalTtlMs ?? this.approvalTtlFromEnv(env);
        this.changes =
            options.changes ??
            new CodingChangeStore(env.DATABASE as never, Math.max(60, Math.ceil(this.approvalTtlMs / 1000) + 60));
        this.configLoader =
            options.configLoader ??
            (async () => {
                ENV.merge(env as Record<string, unknown>);
                await ENV.loadConfig();
            });
    }

    private approvalTtlFromEnv(env: CodingSessionDurableEnv): number {
        const parsed = Number(env.CODING_APPROVAL_TTL_MS);
        return Number.isFinite(parsed) && parsed >= 60_000 ? Math.trunc(parsed) : DEFAULT_APPROVAL_TTL_MS;
    }

    private async getStateInternal(userId: string, chatId: string): Promise<CodingDurableSession | null> {
        let state = await this.loadState();
        if (!state) {
            return null;
        }
        this.assertOwner(state, userId, chatId);
        if (state.expiresAt <= this.now()) {
            await this.expire(state);
            return null;
        }
        const approval = state.approval;
        if (
            approval &&
            ['pending', 'approved', 'applying', 'failed'].includes(approval.status) &&
            approval.expiresAt <= this.now()
        ) {
            const expired = await this.markApproval(state, approval.id, 'expired', { expiredAt: this.now() }, [
                'pending',
                'approved',
                'applying',
                'failed',
            ]);
            if (expired) {
                state = { ...state, approval: expired };
            }
        }
        return clone(state);
    }

    private async createSessionInternal(input: CodingSessionCreateInput): Promise<CodingDurableSession> {
        this.validateIdentity(input.userId, input.chatId);
        const repository = this.normalizeRepository(input.repository);
        const existing = await this.loadState();
        if (existing) {
            this.assertOwner(existing, input.userId, input.chatId);
            if (existing.expiresAt <= this.now()) {
                await this.expire(existing);
            } else if (this.activeJob || isActive(existing.status)) {
                throw new CodingSessionError('active', 'A coding session is already active');
            }
        }

        const now = this.now();
        const job: CodingJobState = {
            id: this.idFactory(),
            kind: 'checkout',
            status: 'queued',
            createdAt: now,
            ...(input.telegram?.messageId ? { telegramMessageId: input.telegram.messageId } : {}),
        };
        const state: CodingDurableSession = {
            version: 2,
            sessionId: this.idFactory(),
            userId: input.userId,
            chatId: input.chatId,
            repository,
            status: 'queued',
            cancellationRequested: false,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + this.ttlMs,
            job,
        };
        await this.saveState(state);
        await this.scheduleImmediate();
        return clone(state);
    }

    private async enqueueInstructionInternal(input: CodingInstructionInput): Promise<CodingDurableSession> {
        this.validateIdentity(input.userId, input.chatId);
        const instruction = input.instruction.trim();
        if (!instruction || instruction.length > MAX_INSTRUCTION_CHARS) {
            throw new CodingSessionError('invalid', 'Coding instructions must be non-empty and reasonably sized');
        }
        let state = await this.loadState();
        if (!state) {
            throw new CodingSessionError('not-found', 'No active coding session');
        }
        this.assertOwner(state, input.userId, input.chatId);
        if (state.expiresAt <= this.now()) {
            await this.expire(state);
            throw new CodingSessionError('expired', 'Coding session expired');
        }
        if (
            this.activeJob ||
            state.status !== 'awaiting_input' ||
            state.job?.status === 'running' ||
            state.job?.status === 'queued'
        ) {
            throw new CodingSessionError('busy', 'The coding agent is already working');
        }
        if (state.cancellationRequested) {
            throw new CodingSessionError('cancelled', 'Coding session was cancelled');
        }
        if (state.approval?.status === 'applying') {
            throw new CodingSessionError('busy', 'An approved change is being written to GitHub');
        }
        if (state.approval?.status === 'pending' || state.approval?.status === 'approved') {
            state = {
                ...state,
                updatedAt: this.now(),
                approval: { ...state.approval, status: 'stale', staleAt: this.now() },
            };
        }

        const now = this.now();
        const job: CodingJobState = {
            id: this.idFactory(),
            kind: 'instruction',
            status: 'queued',
            instruction,
            createdAt: now,
            ...(input.telegram?.messageId ? { telegramMessageId: input.telegram.messageId } : {}),
        };
        const next: CodingDurableSession = {
            ...state,
            status: 'queued',
            cancellationRequested: false,
            updatedAt: now,
            expiresAt: now + this.ttlMs,
            job,
        };
        await this.saveState(next);
        await this.scheduleImmediate();
        return clone(next);
    }

    private async requestCancelInternal(userId: string, chatId: string): Promise<CodingDurableSession | null> {
        const state = await this.loadState();
        if (!state) {
            return null;
        }
        this.assertOwner(state, userId, chatId);
        if (state.expiresAt <= this.now()) {
            await this.expire(state);
            return null;
        }
        if (state.status === 'cancelled') {
            return clone(state);
        }

        const now = this.now();
        const job = state.job;
        if (job && job.status === 'running' && this.activeJob?.jobId === job.id) {
            const next: CodingDurableSession = {
                ...state,
                status: 'cancelling',
                cancellationRequested: true,
                updatedAt: now,
                job: { ...job, status: 'cancelling', cancelRequestedAt: now },
            };
            await this.saveState(next);
            this.activeJob.controller.abort(new CodingSessionError('cancelled', 'Coding session stopped'));
            await this.scheduleHeartbeat();
            return clone(next);
        }

        if (job && job.status === 'queued') {
            return this.finalizeCancelled(state, 'Cancelled before the job started');
        }
        if (job && job.status === 'cancelling') {
            if (this.activeJob?.jobId === job.id) {
                this.activeJob.controller.abort(new CodingSessionError('cancelled', 'Coding session stopped'));
                await this.scheduleHeartbeat();
                return clone(state);
            }
            return this.finalizeCancelled(state, 'Cancelled while stopping');
        }
        if (job && job.status === 'running') {
            // The DO is authoritative: if no active execution exists here, the
            // previous execution cannot still be writing state.
            return this.finalizeCancelled(state, 'Cancelled stale running job');
        }

        const next: CodingDurableSession = {
            ...state,
            status: 'cancelled',
            cancellationRequested: true,
            updatedAt: now,
            ...(state.approval?.status === 'pending' || state.approval?.status === 'approved'
                ? {
                      approval: {
                          ...state.approval,
                          status: 'stale' as const,
                          staleAt: now,
                          error: 'Session was stopped before approval',
                      },
                  }
                : {}),
            job: job ? { ...job, status: job.status === 'completed' ? 'completed' : 'cancelled' } : null,
        };
        await this.saveState(next);
        await this.executor.destroy(this.workspace(next)).catch(() => undefined);
        await this.scheduleExpiry(next);
        return clone(next);
    }

    private async stopSessionInternal(userId: string, chatId: string): Promise<CodingDurableSession | null> {
        const requested = await this.requestCancelInternal(userId, chatId);
        if (!requested) {
            return null;
        }
        if (requested.status !== 'cancelling' || !this.activeJob) {
            return requested;
        }
        const active = this.activeJob;
        await Promise.race([
            active.promise.catch(() => undefined),
            new Promise<void>(resolve => setTimeout(resolve, this.cancelWaitMs)),
        ]);
        const current = await this.loadState();
        return current ? clone(current) : null;
    }

    reviewApproval(input: CodingApprovalRequest): Promise<CodingApprovalReview> {
        return this.serialize(() => this.reviewApprovalInternal(input));
    }

    approveChanges(input: CodingApprovalRequest): Promise<CodingApprovalResult> {
        return this.serialize(() => this.approveChangesInternal(input));
    }

    rejectChanges(input: CodingApprovalRequest): Promise<CodingApprovalResult> {
        return this.serialize(() => this.rejectChangesInternal(input));
    }

    getState(userId: string, chatId: string): Promise<CodingDurableSession | null> {
        return this.serialize(() => this.getStateInternal(userId, chatId));
    }

    createSession(input: CodingSessionCreateInput): Promise<CodingDurableSession> {
        return this.serialize(() => this.createSessionInternal(input));
    }

    enqueueInstruction(input: CodingInstructionInput): Promise<CodingDurableSession> {
        return this.serialize(() => this.enqueueInstructionInternal(input));
    }

    requestCancel(userId: string, chatId: string): Promise<CodingDurableSession | null> {
        return this.serialize(() => this.requestCancelInternal(userId, chatId));
    }

    stopSession(userId: string, chatId: string): Promise<CodingDurableSession | null> {
        return this.serialize(() => this.stopSessionInternal(userId, chatId));
    }

    async runJob(jobId: string): Promise<void> {
        if (this.startingJobs.has(jobId)) {
            return;
        }
        this.startingJobs.add(jobId);
        try {
            await this.runJobInternal(jobId);
        } finally {
            this.startingJobs.delete(jobId);
        }
    }

    async alarm(): Promise<void> {
        try {
            const state = await this.loadState();
            if (!state) {
                return;
            }
            if (state.expiresAt <= this.now()) {
                await this.expire(state);
                return;
            }

            const job = state.job;
            if (!job) {
                await this.scheduleExpiry(state);
                return;
            }
            if (job.status === 'queued') {
                await this.scheduleHeartbeat();
                this.runInBackground(this.runJob(job.id));
                return;
            }
            if (job.status === 'running') {
                if (this.activeJob?.jobId === job.id) {
                    const now = this.now();
                    await this.updateIfCurrent(state.sessionId, job.id, current => ({
                        ...current,
                        updatedAt: now,
                        job: { ...current.job!, heartbeatAt: now },
                    }));
                    await this.scheduleHeartbeat();
                    return;
                }
                const last = job.heartbeatAt ?? job.startedAt ?? job.createdAt;
                if (this.now() - last > this.staleMs) {
                    await this.finalizeFailed(
                        state,
                        'Worker restarted while the job was running; job state was recovered',
                    );
                    return;
                }
                await this.scheduleAt(Math.max(last + this.heartbeatMs, this.now() + this.heartbeatMs));
                return;
            }
            if (job.status === 'cancelling') {
                if (this.activeJob?.jobId === job.id) {
                    this.activeJob.controller.abort(new CodingSessionError('cancelled', 'Coding session stopped'));
                    await this.scheduleHeartbeat();
                    return;
                }
                await this.finalizeCancelled(state, 'Cancellation confirmed');
                return;
            }
            await this.scheduleExpiry(state);
        } catch {
            // Alarms must not throw; the next alarm retries recovery.
        }
    }

    private async runJobInternal(jobId: string): Promise<void> {
        const state = await this.loadState();
        if (!state?.job || state.job.id !== jobId || state.job.status !== 'queued') {
            return;
        }
        const now = this.now();
        const started: CodingDurableSession = {
            ...state,
            status: 'running',
            updatedAt: now,
            expiresAt: now + this.ttlMs,
            job: {
                ...state.job,
                status: 'running',
                startedAt: now,
                heartbeatAt: now,
                progress: state.job.kind === 'checkout' ? 'Preparing repository...' : 'Starting coding agent...',
            },
        };
        await this.saveState(started);
        await this.scheduleHeartbeat();
        await this.reportProgress(started, started.job!.progress ?? 'Working...');

        const controller = new AbortController();
        const active: ActiveJob = { jobId, controller, promise: Promise.resolve() };
        this.activeJob = active;
        const latest = await this.loadState();
        if (!latest || latest.job?.id !== jobId) {
            this.activeJob = null;
            return;
        }
        if (latest.status === 'cancelled' || latest.status === 'failed' || latest.status === 'completed') {
            this.activeJob = null;
            return;
        }
        if (latest.cancellationRequested || latest.status === 'cancelling') {
            controller.abort(new CodingSessionError('cancelled', 'Coding session stopped'));
        }
        active.promise = this.executeAndFinalize(latest, jobId, controller).finally(() => {
            if (this.activeJob === active) {
                this.activeJob = null;
            }
        });
        await active.promise;
    }

    private async executeAndFinalize(
        state: CodingDurableSession,
        jobId: string,
        controller: AbortController,
    ): Promise<void> {
        const job = state.job;
        if (!job || job.id !== jobId) {
            return;
        }
        if (state.status === 'cancelled' || state.status === 'failed' || state.status === 'completed') {
            return;
        }
        if (controller.signal.aborted || state.cancellationRequested || state.status === 'cancelling') {
            await this.finalizeCancelled(state, 'Coding job cancelled');
            return;
        }
        try {
            await this.prepareRuntime();
            const outcome =
                job.kind === 'checkout'
                    ? await this.executeCheckout(state, job, controller.signal)
                    : await this.executeInstruction(state, job, controller.signal);
            if (controller.signal.aborted || (await this.isCancellationRequested(state.sessionId, jobId))) {
                await this.finalizeCancelled(state, 'Coding job cancelled');
                return;
            }
            await this.finalizeCompleted(state, job, outcome);
        } catch (error) {
            if (controller.signal.aborted || (await this.isCancellationRequested(state.sessionId, jobId))) {
                await this.finalizeCancelled(state, 'Coding job cancelled');
                return;
            }
            await this.finalizeFailed(state, safeError(error));
        }
    }

    private async executeCheckout(
        state: CodingDurableSession,
        job: CodingJobState,
        signal: AbortSignal,
    ): Promise<CodingJobOutcome> {
        const result = await this.executor.prepare(this.workspace(state), signal, progress =>
            this.reportProgress(state, progress, job.id),
        );
        await this.updateIfCurrent(state.sessionId, job.id, current => ({
            ...current,
            baseRef: result.ref,
            ...(result.commitSha ? { baseCommitSha: result.commitSha } : {}),
        }));
        return { text: 'Repository loaded. What would you like me to do?' };
    }

    private async executeInstruction(
        state: CodingDurableSession,
        job: CodingJobState,
        signal: AbortSignal,
    ): Promise<CodingJobOutcome> {
        if (!job.instruction) {
            throw new CodingSessionError('invalid', 'Coding job has no instruction');
        }
        const history = await this.history.load(state.userId, state.chatId, state.sessionId);
        const result = await this.executor.run(this.workspace(state), job.instruction, history, signal, progress =>
            this.reportProgress(state, progress, job.id),
        );
        const changeSet =
            state.baseRef && state.baseCommitSha
                ? await this.executor.collectChanges(this.workspace(state), state.baseRef, state.baseCommitSha, signal)
                : null;
        return {
            text: result.text || 'The coding agent returned an empty response.',
            changeSet,
        };
    }

    private async finalizeCompleted(
        state: CodingDurableSession,
        job: CodingJobState,
        outcome: CodingJobOutcome,
    ): Promise<void> {
        const current = await this.loadState();
        if (
            !current ||
            current.sessionId !== state.sessionId ||
            current.job?.id !== job.id ||
            current.status !== 'running' ||
            current.job?.status !== 'running'
        ) {
            return;
        }
        const now = this.now();
        const updated = await this.updateIfCurrent(state.sessionId, job.id, latest => ({
            ...latest,
            status: 'awaiting_input',
            cancellationRequested: false,
            updatedAt: now,
            expiresAt: now + this.ttlMs,
            job: {
                ...latest.job!,
                status: 'completed',
                finishedAt: now,
                progress: 'Completed',
                heartbeatAt: undefined,
            },
        }));
        if (!updated) {
            return;
        }
        if (job.kind === 'instruction' && job.instruction) {
            await this.history
                .append(
                    updated.userId,
                    updated.chatId,
                    updated.sessionId,
                    { role: 'user', content: job.instruction },
                    { role: 'assistant', content: outcome.text },
                )
                .catch(() => undefined);
        }
        await this.notify(updated.sessionId, job.id, outcome.text);
        if (outcome.changeSet?.files.length) {
            const approval = await this.attachApproval(updated, job, outcome.changeSet);
            if (approval) {
                await this.notifyApproval(updated, approval, outcome.changeSet);
            }
        }
        await this.scheduleExpiry(updated);
    }

    private async finalizeFailed(state: CodingDurableSession, error: string): Promise<void> {
        const current = await this.loadState();
        if (
            !current ||
            current.sessionId !== state.sessionId ||
            current.job?.id !== state.job?.id ||
            current.status !== 'running' ||
            current.job?.status !== 'running'
        ) {
            return;
        }
        const now = this.now();
        const updated = await this.updateIfCurrent(state.sessionId, state.job?.id ?? '', latest => ({
            ...latest,
            status: 'failed',
            updatedAt: now,
            expiresAt: now + this.ttlMs,
            job: latest.job
                ? {
                      ...latest.job,
                      status: 'failed',
                      finishedAt: now,
                      error,
                      progress: 'Failed',
                      heartbeatAt: undefined,
                  }
                : null,
        }));
        if (!updated) {
            return;
        }
        await this.executor.destroy(this.workspace(updated)).catch(() => undefined);
        await this.notify(updated.sessionId, updated.job?.id ?? '', `Coding job failed: ${error}`);
        await this.scheduleExpiry(updated);
    }

    private async finalizeCancelled(state: CodingDurableSession, reason: string): Promise<CodingDurableSession | null> {
        const current = await this.loadState();
        if (
            !current ||
            current.sessionId !== state.sessionId ||
            current.job?.id !== state.job?.id ||
            current.status === 'cancelled' ||
            current.status === 'failed' ||
            current.status === 'completed'
        ) {
            return current && current.sessionId === state.sessionId ? clone(current) : null;
        }
        const now = this.now();
        const jobId = state.job?.id ?? '';
        const updated = await this.updateIfCurrent(state.sessionId, jobId, latest => ({
            ...latest,
            status: 'cancelled',
            cancellationRequested: true,
            updatedAt: now,
            expiresAt: now + this.ttlMs,
            job: latest.job
                ? {
                      ...latest.job,
                      status: 'cancelled',
                      finishedAt: now,
                      cancelledAt: now,
                      progress: 'Cancelled',
                      heartbeatAt: undefined,
                  }
                : null,
        }));
        if (!updated) {
            return null;
        }
        await this.executor.destroy(this.workspace(updated)).catch(() => undefined);
        await this.notify(updated.sessionId, jobId, reason);
        await this.scheduleExpiry(updated);
        return clone(updated);
    }

    private async reportProgress(state: CodingDurableSession, progress: string, jobId = state.job?.id): Promise<void> {
        if (!jobId) {
            return;
        }
        const updated = await this.updateIfCurrent(state.sessionId, jobId, current => ({
            ...current,
            updatedAt: this.now(),
            job: { ...current.job!, progress },
        }));
        if (updated) {
            await this.notify(updated.sessionId, jobId, progress);
        }
    }

    private async notify(sessionId: string, jobId: string, text: string): Promise<void> {
        const current = await this.loadState();
        if (!current || current.sessionId !== sessionId || current.job?.id !== jobId) {
            return;
        }
        const target: CodingTelegramTarget = {
            chatId: Number(current.chatId),
            ...(current.job.telegramMessageId ? { messageId: current.job.telegramMessageId } : {}),
        };
        try {
            const messageId = await this.notifier.notify(target, text);
            if (messageId && messageId !== current.job.telegramMessageId) {
                await this.setTelegramMessageId(sessionId, jobId, messageId);
            }
        } catch {
            // Telegram is a best-effort side channel.
        }
    }

    private async setTelegramMessageId(sessionId: string, jobId: string, messageId: number): Promise<void> {
        await this.withStorageLock(async () => {
            const current = await this.loadState();
            if (!current || current.sessionId !== sessionId || current.job?.id !== jobId) {
                return;
            }
            await this.writeState({
                ...current,
                updatedAt: this.now(),
                job: { ...current.job, telegramMessageId: messageId },
            });
        });
    }

    private async isCancellationRequested(sessionId: string, jobId: string): Promise<boolean> {
        const state = await this.loadState();
        return !state || state.sessionId !== sessionId || state.job?.id !== jobId || state.cancellationRequested;
    }

    private async reviewApprovalInternal(input: CodingApprovalRequest): Promise<CodingApprovalReview> {
        const { state, approval } = await this.requireApproval(input);
        if (approval.jobId !== state.job?.id && (approval.status === 'pending' || approval.status === 'approved')) {
            const stale = await this.markApproval(state, approval.id, 'stale', { staleAt: this.now() });
            return { approval: stale ?? approval };
        }
        if (
            ['pending', 'approved', 'applying', 'failed'].includes(approval.status) &&
            approval.expiresAt <= this.now()
        ) {
            const expired = await this.markApproval(state, approval.id, 'expired', { expiredAt: this.now() }, [
                'pending',
                'approved',
                'applying',
                'failed',
            ]);
            return { approval: expired ?? approval };
        }
        if (approval.status === 'pending') {
            const changeSet = await this.validateCurrentDiff(state, approval);
            if (!changeSet) {
                const stale = await this.markApproval(state, approval.id, 'stale', { staleAt: this.now() }, 'pending');
                return { approval: stale ?? approval };
            }
            return { approval, changeSet };
        }
        const changeSet = await this.loadApprovalChangeSet(state, approval);
        return { approval, ...(changeSet ? { changeSet } : {}) };
    }

    private async approveChangesInternal(input: CodingApprovalRequest): Promise<CodingApprovalResult> {
        const { state, approval } = await this.requireApproval(input);
        if (['completed', 'rejected', 'expired', 'stale'].includes(approval.status)) {
            return this.approvalResult(approval);
        }
        if (approval.jobId !== state.job?.id && (approval.status === 'pending' || approval.status === 'approved')) {
            const stale = await this.markApproval(state, approval.id, 'stale', { staleAt: this.now() });
            return this.approvalResult(stale ?? approval);
        }
        if (
            ['pending', 'approved', 'applying', 'failed'].includes(approval.status) &&
            approval.expiresAt <= this.now()
        ) {
            const expired = await this.markApproval(state, approval.id, 'expired', { expiredAt: this.now() }, [
                'pending',
                'approved',
                'applying',
                'failed',
            ]);
            return this.approvalResult(expired ?? approval);
        }
        const changeSet = await this.validateCurrentDiff(state, approval);
        if (!changeSet) {
            const stale = await this.markApproval(state, approval.id, 'stale', { staleAt: this.now() });
            return this.approvalResult(stale ?? approval);
        }
        if (approval.status === 'pending' || approval.status === 'failed') {
            const approved = await this.markApproval(
                state,
                approval.id,
                'approved',
                { approvedAt: this.now() },
                approval.status,
            );
            if (!approved) {
                return this.approvalResult((await this.loadState())?.approval ?? approval);
            }
        }
        const applying = await this.markApproval(
            state,
            approval.id,
            'applying',
            { applyingAt: this.now() },
            approval.status === 'applying' ? 'applying' : 'approved',
        );
        if (!applying) {
            return this.approvalResult((await this.loadState())?.approval ?? approval);
        }
        if (!state.baseRef || !state.baseCommitSha) {
            const failed = await this.markApproval(
                state,
                approval.id,
                'failed',
                {
                    failedAt: this.now(),
                    error: 'The repository base commit is not available; reload the repository.',
                },
                'applying',
            );
            return this.approvalResult(failed ?? applying);
        }
        const branch = this.approvalBranch(state, applying);
        try {
            const written = await this.executor.writeApprovedChanges(this.workspace(state), {
                baseRef: state.baseRef,
                expectedBaseSha: state.baseCommitSha,
                branchName: branch,
                message: `Telegram coding agent: approved change ${approval.id}`,
                changes: changeSet.files.map(file => ({
                    path: file.path,
                    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
                    status: file.status,
                    ...(file.contentBase64 ? { contentBase64: file.contentBase64 } : {}),
                    sha256: file.sha256,
                })),
            });
            const completed = await this.markApproval(
                state,
                approval.id,
                'completed',
                {
                    completedAt: this.now(),
                    branch: written.branch,
                    commitSha: written.commitSha,
                },
                'applying',
            );
            return {
                approval: completed ?? applying,
                branch: written.branch,
                commitSha: written.commitSha,
            };
        } catch (error) {
            const failed = await this.markApproval(
                state,
                approval.id,
                'failed',
                {
                    failedAt: this.now(),
                    error: safeError(error),
                },
                'applying',
            );
            return this.approvalResult(failed ?? applying);
        }
    }

    private async rejectChangesInternal(input: CodingApprovalRequest): Promise<CodingApprovalResult> {
        const { state, approval } = await this.requireApproval(input);
        if (approval.status === 'rejected') {
            return this.approvalResult(approval);
        }
        if (approval.status === 'completed') {
            return this.approvalResult(approval);
        }
        if (approval.jobId !== state.job?.id && (approval.status === 'pending' || approval.status === 'approved')) {
            const stale = await this.markApproval(state, approval.id, 'stale', { staleAt: this.now() });
            return this.approvalResult(stale ?? approval);
        }
        if (
            ['pending', 'approved', 'applying', 'failed'].includes(approval.status) &&
            approval.expiresAt <= this.now()
        ) {
            const expired = await this.markApproval(state, approval.id, 'expired', { expiredAt: this.now() }, [
                'pending',
                'approved',
                'applying',
                'failed',
            ]);
            return this.approvalResult(expired ?? approval);
        }
        if (approval.status === 'applying') {
            return this.approvalResult(approval);
        }
        if (approval.status === 'pending' || approval.status === 'approved') {
            const rejected = await this.markApproval(state, approval.id, 'rejected', { rejectedAt: this.now() }, [
                'pending',
                'approved',
            ]);
            return this.approvalResult(rejected ?? approval);
        }
        return this.approvalResult(approval);
    }

    private async requireApproval(
        input: CodingApprovalRequest,
    ): Promise<{ state: CodingDurableSession; approval: CodingApprovalState }> {
        this.validateIdentity(input.userId, input.chatId);
        const state = await this.loadState();
        if (!state) {
            throw new CodingSessionError('not-found', 'No active coding session');
        }
        this.assertOwner(state, input.userId, input.chatId);
        const approval = state.approval;
        if (!approval) {
            throw new CodingSessionError('not-found', 'No approval is pending for this session');
        }
        if (
            approval.id !== input.approvalId ||
            approval.nonce !== input.nonce ||
            approval.sessionId !== state.sessionId ||
            approval.userId !== input.userId ||
            approval.chatId !== input.chatId
        ) {
            throw new CodingSessionError('invalid', 'Invalid or stale approval callback');
        }
        return { state, approval };
    }

    private async validateCurrentDiff(
        state: CodingDurableSession,
        approval: CodingApprovalState,
    ): Promise<CodingChangeSet | null> {
        if (!state.baseRef || !state.baseCommitSha) {
            return null;
        }
        try {
            const current = await this.executor.collectChanges(
                this.workspace(state),
                state.baseRef,
                state.baseCommitSha,
            );
            return current && current.diffHash === approval.diffHash ? current : null;
        } catch (error) {
            if (error instanceof CodingSessionError && error.code === 'stale') {
                return null;
            }
            throw error;
        }
    }

    private async loadApprovalChangeSet(
        state: CodingDurableSession,
        approval: CodingApprovalState,
    ): Promise<CodingChangeSet | null> {
        const changeSet = await this.changes.load(state.userId, state.chatId, approval.changeKey);
        if (
            !changeSet ||
            changeSet.diffHash !== approval.diffHash ||
            changeSet.repository !== state.repository ||
            changeSet.files.length === 0
        ) {
            return null;
        }
        return changeSet;
    }

    private async markApproval(
        state: CodingDurableSession,
        approvalId: string,
        status: CodingApprovalStatus,
        extra: Partial<CodingApprovalState> = {},
        expected?: CodingApprovalStatus | readonly CodingApprovalStatus[],
    ): Promise<CodingApprovalState | null> {
        return this.withStorageLock(async () => {
            const current = await this.loadState();
            if (!current || current.sessionId !== state.sessionId || current.approval?.id !== approvalId) {
                return null;
            }
            if (expected) {
                const allowed = typeof expected === 'string' ? [expected] : expected;
                if (!allowed.includes(current.approval.status)) {
                    return null;
                }
            }
            const nextApproval: CodingApprovalState = { ...current.approval, status, ...extra };
            if (!['failed', 'stale', 'expired'].includes(status)) {
                delete nextApproval.error;
            }
            await this.writeState({ ...current, approval: nextApproval, updatedAt: this.now() });
            return nextApproval;
        });
    }

    private async attachApproval(
        state: CodingDurableSession,
        job: CodingJobState,
        changeSet: CodingChangeSet,
    ): Promise<CodingApprovalState | null> {
        const now = this.now();
        const id = this.approvalToken();
        const nonce = this.approvalToken();
        const approval: CodingApprovalState = {
            id,
            nonce,
            status: 'pending',
            sessionId: state.sessionId,
            jobId: job.id,
            userId: state.userId,
            chatId: state.chatId,
            diffHash: changeSet.diffHash,
            changeKey: id,
            createdAt: now,
            expiresAt: now + this.approvalTtlMs,
        };
        try {
            await this.changes.save(state.userId, state.chatId, approval.changeKey, changeSet);
        } catch {
            return null;
        }
        const attached = await this.withStorageLock(async () => {
            const current = await this.loadState();
            if (
                !current ||
                current.sessionId !== state.sessionId ||
                current.job?.id !== job.id ||
                current.status !== 'awaiting_input'
            ) {
                return null;
            }
            await this.writeState({
                ...current,
                approval,
                updatedAt: now,
                expiresAt: Math.max(current.expiresAt, approval.expiresAt),
            });
            return approval;
        });
        if (!attached) {
            await this.changes.delete(state.userId, state.chatId, approval.changeKey).catch(() => undefined);
        }
        return attached;
    }

    private async notifyApproval(
        state: CodingDurableSession,
        approval: CodingApprovalState,
        changeSet: CodingChangeSet,
    ): Promise<void> {
        const target: CodingTelegramTarget = { chatId: Number(state.chatId) };
        const text = this.formatApprovalSummary(approval, changeSet);
        const keyboard = this.approvalKeyboard(approval);
        try {
            let messageId: number | undefined;
            if (changeSet.diff.length > APPROVAL_DIFF_MESSAGE_LIMIT && this.notifier.sendDocument) {
                try {
                    messageId = await this.notifier.sendDocument(
                        target,
                        `changes-${approval.id}.diff`,
                        new TextEncoder().encode(changeSet.diff),
                        { caption: text, keyboard },
                    );
                } catch {
                    messageId = undefined;
                }
            }
            if (!messageId) {
                messageId = await this.notifier.notify(target, text, { keyboard });
            }
            if (messageId) {
                await this.setApprovalMessageId(state.sessionId, approval.id, messageId);
            }
        } catch {
            // Telegram is a best-effort side channel; approval state remains authoritative.
        }
    }

    private formatApprovalSummary(approval: CodingApprovalState, changeSet: CodingChangeSet): string {
        return [
            'Changes are ready for review.',
            changeSet.summary,
            `Repository: ${changeSet.repository}`,
            `Base: ${changeSet.baseRef} @ ${changeSet.baseCommitSha.slice(0, 12)}`,
            `Approval expires: ${new Date(approval.expiresAt).toISOString()}`,
            '',
            'Approving writes a new branch only. It never merges, deploys or updates the default branch.',
            'Only the original user in this private chat can approve.',
        ].join('\n');
    }

    private approvalKeyboard(approval: CodingApprovalState): Telegram.InlineKeyboardMarkup {
        const button = (text: string, action: CodingApprovalAction): Telegram.InlineKeyboardButton => ({
            text,
            callback_data: codingApprovalCallbackData(action, approval.id, approval.nonce),
        });
        return {
            inline_keyboard: [
                [button('Review changes', 'review')],
                [button('Approve and save to GitHub', 'approve'), button('Reject changes', 'reject')],
            ],
        };
    }

    private async setApprovalMessageId(sessionId: string, approvalId: string, messageId: number): Promise<void> {
        await this.withStorageLock(async () => {
            const current = await this.loadState();
            if (!current || current.sessionId !== sessionId || current.approval?.id !== approvalId) {
                return;
            }
            await this.writeState({
                ...current,
                updatedAt: this.now(),
                approval: { ...current.approval, telegramMessageId: messageId },
            });
        });
    }

    private approvalToken(): string {
        const token = this.idFactory()
            .replace(/[^A-Za-z0-9_-]/g, '')
            .slice(0, 16);
        return token || 'approval';
    }

    private approvalBranch(state: CodingDurableSession, approval: CodingApprovalState): string {
        const session = state.sessionId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 8) || 'session';
        const id = approval.id.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 8) || 'change';
        return `telegram-agent/${session}-${id}`;
    }

    private approvalResult(approval: CodingApprovalState): CodingApprovalResult {
        return {
            approval,
            ...(approval.branch ? { branch: approval.branch } : {}),
            ...(approval.commitSha ? { commitSha: approval.commitSha } : {}),
        };
    }

    private async updateIfCurrent(
        sessionId: string,
        jobId: string,
        update: (state: CodingDurableSession) => CodingDurableSession,
    ): Promise<CodingDurableSession | null> {
        return this.withStorageLock(async () => {
            const current = await this.loadState();
            if (
                !current ||
                current.sessionId !== sessionId ||
                current.job?.id !== jobId ||
                current.status === 'cancelled' ||
                current.status === 'failed' ||
                current.status === 'completed'
            ) {
                return null;
            }
            const next = update(current);
            next.updatedAt = this.now();
            await this.writeState(next);
            return next;
        });
    }

    private withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
        const key = this.ctx.storage as object;
        const previous = storageLocks.get(key) ?? Promise.resolve();
        const run = previous.then(operation, operation);
        storageLocks.set(
            key,
            run.then(
                () => undefined,
                () => undefined,
            ),
        );
        return run;
    }

    private async expire(state: CodingDurableSession): Promise<void> {
        const active = this.activeJob;
        if (active && active.jobId === state.job?.id) {
            active.controller.abort(new CodingSessionError('cancelled', 'Coding session expired'));
        }
        try {
            await this.notifier.notify(
                {
                    chatId: Number(state.chatId),
                    ...(state.job?.telegramMessageId ? { messageId: state.job.telegramMessageId } : {}),
                },
                'Coding session expired.',
            );
        } catch {
            // Expiry must not depend on Telegram availability.
        }
        await this.ctx.storage.delete(STATE_KEY).catch(() => undefined);
        await this.ctx.storage.deleteAlarm().catch(() => undefined);
        await this.history.clear(state.userId, state.chatId, state.sessionId).catch(() => undefined);
        if (state.approval) {
            await this.changes.delete(state.userId, state.chatId, state.approval.changeKey).catch(() => undefined);
        }
        await this.executor.destroy(this.workspace(state)).catch(() => undefined);
    }

    private async prepareRuntime(): Promise<void> {
        await this.configLoader();
    }

    private workspace(state: CodingDurableSession): CodingWorkspaceSession {
        return {
            userId: state.userId,
            chatId: state.chatId,
            repository: state.repository,
            sessionId: state.sessionId,
        };
    }

    private validateIdentity(userId: string, chatId: string): void {
        if (!USER_ID_PATTERN.test(userId) || !USER_ID_PATTERN.test(chatId)) {
            throw new CodingSessionError('invalid', 'Invalid Telegram user or chat identity');
        }
    }

    private normalizeRepository(repository: string): string {
        const normalized = repository.trim().toLowerCase();
        if (!REPOSITORY_PATTERN.test(normalized)) {
            throw new CodingSessionError('invalid', 'Repository must be in owner/name form');
        }
        return normalized;
    }

    private assertOwner(state: CodingDurableSession, userId: string, chatId: string): void {
        if (state.userId !== userId || state.chatId !== chatId) {
            throw new CodingSessionError('unauthorized', 'Coding session does not belong to this user');
        }
    }

    private async loadState(): Promise<CodingDurableSession | null> {
        const value = await this.ctx.storage.get<unknown>(STATE_KEY);
        if (value === undefined || value === null) {
            return null;
        }
        if (!isValidState(value)) {
            await this.ctx.storage.delete(STATE_KEY).catch(() => undefined);
            return null;
        }
        return value;
    }

    private async saveState(state: CodingDurableSession): Promise<void> {
        await this.withStorageLock(() => this.writeState(state));
    }

    private async writeState(state: CodingDurableSession): Promise<void> {
        await this.ctx.storage.put(STATE_KEY, state);
    }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.operationQueue.then(operation, operation);
        this.operationQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private runInBackground(promise: Promise<unknown>): void {
        const guarded = promise.catch(() => undefined);
        if (this.ctx.waitUntil) {
            this.ctx.waitUntil(guarded);
        } else {
            void guarded;
        }
    }

    private async scheduleImmediate(): Promise<void> {
        await this.scheduleAt(this.now() + 50);
    }

    private async scheduleHeartbeat(): Promise<void> {
        await this.scheduleAt(this.now() + this.heartbeatMs);
    }

    private async scheduleExpiry(state: CodingDurableSession): Promise<void> {
        if (state.job && (state.job.status === 'queued' || state.job.status === 'running')) {
            await this.scheduleHeartbeat();
            return;
        }
        await this.scheduleAt(state.expiresAt);
    }

    private async scheduleAt(time: number): Promise<void> {
        await this.ctx.storage.setAlarm(Math.max(time, this.now() + 1));
    }
}
