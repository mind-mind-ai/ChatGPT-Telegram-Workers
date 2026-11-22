import { describe, expect, it, vi } from 'vitest';
import type { CodingAgentExecutor } from './executor';
import { CodingChangeStore, type CodingHistoryStore } from './history';
import type { CodingJobNotifier } from './notifier';
import {
    CodingSessionDurableObject,
    type CodingSessionDurableEnv,
    type CodingSessionDurableObjectOptions,
    type CodingSessionDurableStorage,
} from './durable-object';
import { MemoryKV, deferred } from './test-helpers';
import type { CodingChangeSet, CodingDurableSession, CodingTelegramTarget } from './types';

class MemoryDurableStorage implements CodingSessionDurableStorage {
    readonly values = new Map<string, unknown>();
    alarm: number | null = null;

    async get<T = unknown>(key: string): Promise<T | undefined> {
        const value = this.values.get(key);
        return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
    }

    async put<T = unknown>(key: string, value: T): Promise<void> {
        this.values.set(key, JSON.parse(JSON.stringify(value)) as T);
    }

    async delete(key: string): Promise<boolean> {
        return this.values.delete(key);
    }

    async setAlarm(time: number): Promise<void> {
        this.alarm = time;
    }

    async getAlarm(): Promise<number | null> {
        return this.alarm;
    }

    async deleteAlarm(): Promise<void> {
        this.alarm = null;
    }
}

class FakeContext {
    readonly storage: MemoryDurableStorage;
    readonly tasks: Promise<unknown>[] = [];

    constructor(storage: MemoryDurableStorage) {
        this.storage = storage;
    }

    waitUntil(promise: Promise<unknown>): void {
        this.tasks.push(promise);
    }

    async drain(): Promise<void> {
        while (this.tasks.length) {
            await Promise.all(this.tasks.splice(0));
        }
    }
}

class FakeHistory {
    readonly messages = new Map<string, unknown[]>();
    load = vi.fn(async (userId: string, chatId: string, sessionId: string) => {
        return (this.messages.get(`${userId}:${chatId}:${sessionId}`) ?? []) as never;
    });
    append = vi.fn(async () => undefined);
    clear = vi.fn(async () => undefined);
}

class FakeNotifier implements CodingJobNotifier {
    readonly messages: {
        target: CodingTelegramTarget | undefined;
        text: string;
        keyboard?: unknown;
    }[] = [];
    readonly documents: { filename: string; content: Uint8Array; caption?: string }[] = [];
    fail = false;

    async notify(
        target: CodingTelegramTarget | undefined,
        text: string,
        options: { keyboard?: unknown } = {},
    ): Promise<number | undefined> {
        if (this.fail) {
            throw new Error('telegram unavailable');
        }
        this.messages.push({ target, text, ...(options.keyboard ? { keyboard: options.keyboard } : {}) });
        return target?.messageId ?? 100 + this.messages.length;
    }

    async sendDocument(
        target: CodingTelegramTarget | undefined,
        filename: string,
        content: Uint8Array,
        options: { caption?: string } = {},
    ): Promise<number | undefined> {
        if (this.fail) {
            throw new Error('telegram unavailable');
        }
        this.documents.push({ filename, content, ...(options.caption ? { caption: options.caption } : {}) });
        return target?.messageId ?? 100 + this.messages.length + this.documents.length;
    }
}

function fakeExecutor(
    prepare?: (signal: AbortSignal, progress: (text: string) => void) => Promise<void>,
    run?: (
        signal: AbortSignal,
        progress: (text: string) => void,
    ) => Promise<{ text: string; steps: number; stopReason: 'complete' }>,
): CodingAgentExecutor {
    return {
        prepare: vi.fn(async (_session: unknown, signal: AbortSignal, onProgress: (text: string) => void) => {
            onProgress?.('Checking out repository...');
            await prepare?.(signal, onProgress);
            return {
                repository: { owner: 'octo', name: 'repo', fullName: 'octo/repo' },
                ref: 'main',
                commitSha: 'a'.repeat(40),
                filesWritten: 1,
                bytesWritten: 5,
                skippedFiles: 0,
            };
        }),
        run: vi.fn(
            async (
                _session: unknown,
                _instruction: unknown,
                _history: unknown,
                signal: AbortSignal,
                onProgress: (text: string) => void,
            ) => {
                onProgress?.('Running the coding agent...');
                return run?.(signal, onProgress) ?? { text: 'done', steps: 1, stopReason: 'complete' as const };
            },
        ),
        collectChanges: vi.fn(async () => null),
        writeApprovedChanges: vi.fn(async () => ({
            repository: { owner: 'octo', name: 'repo', fullName: 'octo/repo' },
            baseRef: 'main',
            baseSha: 'a'.repeat(40),
            branch: 'telegram-agent/test',
            commitSha: 'b'.repeat(40),
            filesChanged: 1,
        })),
        destroy: vi.fn(async () => undefined),
    } as unknown as CodingAgentExecutor;
}

interface Harness {
    storage: MemoryDurableStorage;
    ctx: FakeContext;
    executor: CodingAgentExecutor;
    history: FakeHistory;
    notifier: FakeNotifier;
    object: CodingSessionDurableObject;
}

function harness(
    options: {
        storage?: MemoryDurableStorage;
        executor?: CodingAgentExecutor;
        history?: FakeHistory;
        notifier?: FakeNotifier;
        changes?: CodingChangeStore;
        now?: () => number;
        idFactory?: () => string;
        staleMs?: number;
        heartbeatMs?: number;
        cancelWaitMs?: number;
    } = {},
): Harness {
    const storage = options.storage ?? new MemoryDurableStorage();
    const ctx = new FakeContext(storage);
    const executor = options.executor ?? fakeExecutor();
    const history = options.history ?? new FakeHistory();
    const notifier = options.notifier ?? new FakeNotifier();
    const changes = options.changes ?? new CodingChangeStore(new MemoryKV(), 3_600);
    let id = 0;
    const object = new CodingSessionDurableObject(
        ctx,
        {} as CodingSessionDurableEnv,
        {
            executor,
            history: history as unknown as CodingHistoryStore,
            notifier,
            changes,
            now: options.now ?? (() => 1_000),
            idFactory: options.idFactory ?? (() => `id-${++id}`),
            staleMs: options.staleMs,
            heartbeatMs: options.heartbeatMs,
            approvalTtlMs: 900_000,
            cancelWaitMs: options.cancelWaitMs,
            configLoader: async () => undefined,
        } as CodingSessionDurableObjectOptions,
    );
    return { storage, ctx, executor, history, notifier, object };
}

async function waitFor(check: () => boolean | Promise<boolean>, attempts = 30): Promise<void> {
    for (let index = 0; index < attempts; index += 1) {
        if (await check()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('condition not reached');
}

describe('CodingSessionDurableObject', () => {
    it('creates one authoritative queued session with a persisted job', async () => {
        const h = harness();
        const created = await h.object.createSession({ userId: '10', chatId: '10', repository: 'Octo/Repo' });
        expect(created.status).toBe('queued');
        expect(created.repository).toBe('octo/repo');
        expect(created.job).toMatchObject({ kind: 'checkout', status: 'queued' });
        expect(h.storage.alarm).not.toBeNull();
        await expect(h.object.getState('10', '10')).resolves.toMatchObject({
            sessionId: created.sessionId,
            status: 'queued',
        });
    });

    it('serializes concurrent create requests for the same user/chat', async () => {
        const h = harness();
        const results = await Promise.allSettled([
            h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' }),
            h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' }),
        ]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        const rejected = results.find(result => result.status === 'rejected');
        expect(rejected && rejected.status === 'rejected' ? rejected.reason.code : undefined).toBe('active');
    });

    it('runs checkout through an alarm and persists progress', async () => {
        const h = harness();
        await h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await h.object.alarm();
        await h.ctx.drain();
        const state = await h.object.getState('10', '10');
        expect(state?.status).toBe('awaiting_input');
        expect(state?.job).toMatchObject({ kind: 'checkout', status: 'completed' });
        expect(h.executor.prepare).toHaveBeenCalledTimes(1);
        expect(h.notifier.messages.some(message => message.text.includes('Repository loaded'))).toBe(true);
    });

    it('prevents duplicate execution of the same queued job', async () => {
        const h = harness();
        await h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await Promise.all([h.object.alarm(), h.object.alarm()]);
        await h.ctx.drain();
        expect(h.executor.prepare).toHaveBeenCalledTimes(1);
    });

    it('rejects a second operation from a simulated second Worker isolate', async () => {
        const deferredPrepare = deferred<void>();
        const h1 = harness({ executor: fakeExecutor(() => deferredPrepare.promise) });
        const h2 = harness({ storage: h1.storage });
        await h1.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await h1.object.alarm();
        await waitFor(async () => (await h2.object.getState('10', '10'))?.status === 'running');
        await expect(
            h2.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' }),
        ).rejects.toMatchObject({ code: 'active' });
        await expect(
            h2.object.enqueueInstruction({ userId: '10', chatId: '10', instruction: 'work' }),
        ).rejects.toMatchObject({ code: 'busy' });
        deferredPrepare.resolve();
        await h1.ctx.drain();
        expect((await h1.object.getState('10', '10'))?.status).toBe('awaiting_input');
    });

    it('cancels across simulated isolates and refuses stale completion', async () => {
        const deferredPrepare = deferred<void>();
        const h1 = harness({ executor: fakeExecutor(() => deferredPrepare.promise) });
        const h2 = harness({ storage: h1.storage });
        await h1.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await h1.object.alarm();
        await waitFor(async () => (await h1.object.getState('10', '10'))?.status === 'running');
        const stopped = await h2.object.stopSession('10', '10');
        expect(stopped?.status).toBe('cancelled');
        expect(stopped?.job?.status).toBe('cancelled');
        expect((await h1.object.getState('10', '10'))?.status).toBe('cancelled');
        deferredPrepare.resolve();
        await h1.ctx.drain();
        const final = await h1.object.getState('10', '10');
        expect(final?.status).toBe('cancelled');
        expect(final?.job?.status).toBe('cancelled');
    });

    it('does not claim cancellation until a running job has stopped', async () => {
        const deferredRun = deferred<void>();
        const h = harness({
            executor: fakeExecutor(
                async () => undefined,
                () => deferredRun.promise.then(() => ({ text: 'done', steps: 1, stopReason: 'complete' as const })),
            ),
            cancelWaitMs: 5,
        });
        const created = await h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await h.object.alarm();
        await h.ctx.drain();
        await h.object.enqueueInstruction({
            userId: '10',
            chatId: '10',
            instruction: 'work',
        });
        await h.object.alarm();
        await waitFor(() => (h.executor.run as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0);
        const stopping = await h.object.stopSession('10', '10');
        expect(stopping?.status).toBe('cancelling');
        deferredRun.resolve();
        await h.ctx.drain();
        expect((await h.object.getState('10', '10'))?.status).toBe('cancelled');
        expect(created.sessionId).toBeTruthy();
    });

    it('recovers a queued job in a fresh object after a Worker restart', async () => {
        const h1 = harness();
        await h1.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        const h2 = harness({ storage: h1.storage });
        await h2.object.alarm();
        await h2.ctx.drain();
        expect((await h2.object.getState('10', '10'))?.status).toBe('awaiting_input');
        expect(h2.executor.prepare).toHaveBeenCalledTimes(1);
    });

    it('recovers a stale running job as failed after a Worker restart', async () => {
        let now = 1_000;
        const deferredPrepare = deferred<void>();
        const h1 = harness({ executor: fakeExecutor(() => deferredPrepare.promise), now: () => now });
        await h1.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await h1.object.alarm();
        await waitFor(async () => (await h1.object.getState('10', '10'))?.status === 'running');
        now += 10 * 60 * 1000;
        const h2 = harness({ storage: h1.storage, now: () => now, staleMs: 60_000 });
        await h2.object.alarm();
        await h2.ctx.drain();
        expect((await h2.object.getState('10', '10'))?.status).toBe('failed');
        deferredPrepare.resolve();
        await h1.ctx.drain();
        expect((await h2.object.getState('10', '10'))?.status).toBe('failed');
    });

    it('spaces heartbeat alarms after a restart instead of spinning', async () => {
        let now = 1_000;
        const deferredPrepare = deferred<void>();
        const h1 = harness({
            executor: fakeExecutor(() => deferredPrepare.promise),
            now: () => now,
            heartbeatMs: 30_000,
        });
        await h1.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await h1.object.alarm();
        await waitFor(async () => (await h1.object.getState('10', '10'))?.status === 'running');
        now += 31_000;
        const h2 = harness({ storage: h1.storage, now: () => now, heartbeatMs: 30_000, staleMs: 300_000 });
        await h2.object.alarm();
        expect(h2.storage.alarm).toBeGreaterThanOrEqual(now + 30_000);
        deferredPrepare.resolve();
        await h1.ctx.drain();
    });

    it('expires stale sessions without leaving writable state', async () => {
        let now = 1_000;
        const h = harness({ now: () => now });
        await h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        now += 31 * 60 * 1000;
        await expect(h.object.getState('10', '10')).resolves.toBeNull();
        expect(h.storage.values.size).toBe(0);
        await expect(
            h.object.enqueueInstruction({ userId: '10', chatId: '10', instruction: 'work' }),
        ).rejects.toMatchObject({
            code: 'not-found',
        });
    });

    it('keeps durable state intact when Telegram progress fails', async () => {
        const notifier = new FakeNotifier();
        notifier.fail = true;
        const h = harness({ notifier });
        await h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await h.object.alarm();
        await h.ctx.drain();
        const state = await h.object.getState('10', '10');
        expect(state?.status).toBe('awaiting_input');
        expect(state?.job?.status).toBe('completed');
    });

    it('runs one instruction at a time and stores the result in coding history', async () => {
        const h = harness();
        await h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await h.object.alarm();
        await h.ctx.drain();

        await h.object.enqueueInstruction({ userId: '10', chatId: '10', instruction: 'fix the bug' });
        await expect(
            h.object.enqueueInstruction({ userId: '10', chatId: '10', instruction: 'do something else' }),
        ).rejects.toMatchObject({ code: 'busy' });
        await h.object.alarm();
        await h.ctx.drain();

        const state = await h.object.getState('10', '10');
        expect(state?.status).toBe('awaiting_input');
        expect(state?.job).toMatchObject({ kind: 'instruction', status: 'completed' });
        expect(h.history.append).toHaveBeenCalledWith(
            '10',
            '10',
            state?.sessionId,
            { role: 'user', content: 'fix the bug' },
            { role: 'assistant', content: 'done' },
        );
        expect(h.notifier.messages.some(message => message.text === 'done')).toBe(true);
    });

    it('rejects access from a different user', async () => {
        const h = harness();
        await h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
        await expect(h.object.getState('11', '10')).rejects.toMatchObject({ code: 'unauthorized' });
        await expect(
            h.object.enqueueInstruction({ userId: '11', chatId: '10', instruction: 'x' }),
        ).rejects.toMatchObject({
            code: 'unauthorized',
        });
        await expect(h.object.stopSession('11', '10')).rejects.toMatchObject({ code: 'unauthorized' });
    });
});

function proposedChangeSet(overrides: Partial<CodingChangeSet> = {}): CodingChangeSet {
    return {
        repository: 'octo/repo',
        baseRef: 'main',
        baseCommitSha: 'a'.repeat(40),
        diffHash: '1'.repeat(64),
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        files: [
            {
                path: 'src/a.ts',
                status: 'modified',
                sha256: '2'.repeat(64),
                size: 3,
                additions: 1,
                deletions: 1,
                contentBase64: 'bmV3',
            },
        ],
        summary: '1 file changed: 1 modified\n+1 -1\nDiff SHA-256: ' + '1'.repeat(64),
        createdAt: 1_000,
        ...overrides,
    };
}

function approvalExecutor(
    options: {
        changes?: () => Promise<CodingChangeSet | null>;
        write?: () => Promise<{
            repository: { owner: string; name: string; fullName: string };
            baseRef: string;
            baseSha: string;
            branch: string;
            commitSha: string;
            filesChanged: number;
        }>;
    } = {},
) {
    return {
        prepare: vi.fn(async () => ({
            repository: { owner: 'octo', name: 'repo', fullName: 'octo/repo' },
            ref: 'main',
            commitSha: 'a'.repeat(40),
            filesWritten: 1,
            bytesWritten: 1,
            skippedFiles: 0,
        })),
        run: vi.fn(async () => ({ text: 'Implemented the change.', steps: 1, stopReason: 'complete' as const })),
        collectChanges: vi.fn(options.changes ?? (async () => proposedChangeSet())),
        writeApprovedChanges: vi.fn(
            options.write ??
                (async () => ({
                    repository: { owner: 'octo', name: 'repo', fullName: 'octo/repo' },
                    baseRef: 'main',
                    baseSha: 'a'.repeat(40),
                    branch: 'telegram-agent/session-1',
                    commitSha: 'b'.repeat(40),
                    filesChanged: 1,
                })),
        ),
        destroy: vi.fn(async () => undefined),
    } as unknown as CodingAgentExecutor;
}

async function readyForApproval(h: Harness): Promise<CodingDurableSession> {
    await h.object.createSession({ userId: '10', chatId: '10', repository: 'octo/repo' });
    await h.object.alarm();
    await h.ctx.drain();
    await h.object.enqueueInstruction({ userId: '10', chatId: '10', instruction: 'implement it' });
    await h.object.alarm();
    await h.ctx.drain();
    const state = await h.object.getState('10', '10');
    if (!state?.approval) {
        throw new Error('approval was not created');
    }
    return state;
}

describe('CodingSessionDurableObject approvals', () => {
    it('collects a complete change set and sends review, approve and reject buttons', async () => {
        const h = harness({ executor: approvalExecutor() });
        const state = await readyForApproval(h);
        expect(state.status).toBe('awaiting_input');
        expect(state.baseRef).toBe('main');
        expect(state.baseCommitSha).toBe('a'.repeat(40));
        expect(state.approval).toMatchObject({ status: 'pending', diffHash: '1'.repeat(64) });
        expect(h.notifier.messages.some(message => message.text.includes('Changes are ready for review'))).toBe(true);
        const approvalMessage = h.notifier.messages.find(message => message.keyboard);
        expect(approvalMessage?.keyboard).toMatchObject({
            inline_keyboard: [
                [{ callback_data: expect.stringContaining('code:approval:review:') }],
                [
                    { callback_data: expect.stringContaining('code:approval:approve:') },
                    { callback_data: expect.stringContaining('code:approval:reject:') },
                ],
            ],
        });
        const keyboard = approvalMessage?.keyboard as { inline_keyboard: { callback_data: string }[][] };
        for (const button of keyboard.inline_keyboard.flat()) {
            expect(button.callback_data.length).toBeLessThanOrEqual(64);
        }
    });

    it('reviews the exact stored diff without writing to GitHub', async () => {
        const h = harness({ executor: approvalExecutor() });
        const state = await readyForApproval(h);
        const review = await h.object.reviewApproval({
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        });
        expect(review.changeSet?.diff).toContain('+new');
        expect(review.changeSet?.diffHash).toBe('1'.repeat(64));
        expect(h.executor.writeApprovedChanges).not.toHaveBeenCalled();
    });

    it('writes approved changes once and returns the created branch and commit', async () => {
        const h = harness({ executor: approvalExecutor() });
        const state = await readyForApproval(h);
        const request = {
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        };
        const result = await h.object.approveChanges(request);
        expect(result.approval.status).toBe('completed');
        expect(result.branch).toBe('telegram-agent/session-1');
        expect(result.commitSha).toBe('b'.repeat(40));
        expect(h.executor.writeApprovedChanges).toHaveBeenCalledTimes(1);
        expect(h.executor.writeApprovedChanges).toHaveBeenCalledWith(
            expect.objectContaining({ repository: 'octo/repo' }),
            expect.objectContaining({
                baseRef: 'main',
                expectedBaseSha: 'a'.repeat(40),
                changes: [
                    expect.objectContaining({
                        path: 'src/a.ts',
                        status: 'modified',
                        contentBase64: 'bmV3',
                        sha256: '2'.repeat(64),
                    }),
                ],
            }),
        );
        expect((await h.object.getState('10', '10'))?.approval?.status).toBe('completed');

        const replay = await h.object.approveChanges(request);
        expect(replay.approval.status).toBe('completed');
        expect(h.executor.writeApprovedChanges).toHaveBeenCalledTimes(1);
    });

    it('rejects changes without writing to GitHub', async () => {
        const h = harness({ executor: approvalExecutor() });
        const state = await readyForApproval(h);
        const result = await h.object.rejectChanges({
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        });
        expect(result.approval.status).toBe('rejected');
        expect(h.executor.writeApprovedChanges).not.toHaveBeenCalled();
    });

    it('rejects wrong users, wrong nonces and stale session bindings', async () => {
        const h = harness({ executor: approvalExecutor() });
        const state = await readyForApproval(h);
        await expect(
            h.object.approveChanges({
                userId: '11',
                chatId: '10',
                approvalId: state.approval!.id,
                nonce: state.approval!.nonce,
            }),
        ).rejects.toMatchObject({ code: 'unauthorized' });
        await expect(
            h.object.approveChanges({
                userId: '10',
                chatId: '10',
                approvalId: state.approval!.id,
                nonce: 'wrong',
            }),
        ).rejects.toMatchObject({ code: 'invalid' });
        await expect(
            h.object.approveChanges({
                userId: '10',
                chatId: '10',
                approvalId: 'other',
                nonce: state.approval!.nonce,
            }),
        ).rejects.toMatchObject({ code: 'invalid' });
        expect(h.executor.writeApprovedChanges).not.toHaveBeenCalled();
    });

    it('retries a failed GitHub write safely after the user presses approve again', async () => {
        let attempts = 0;
        const h = harness({
            executor: approvalExecutor({
                write: async () => {
                    attempts += 1;
                    if (attempts === 1) {
                        throw new Error('temporary GitHub outage');
                    }
                    return {
                        repository: { owner: 'octo', name: 'repo', fullName: 'octo/repo' },
                        baseRef: 'main',
                        baseSha: 'a'.repeat(40),
                        branch: 'telegram-agent/session-1',
                        commitSha: 'b'.repeat(40),
                        filesChanged: 1,
                    };
                },
            }),
        });
        const state = await readyForApproval(h);
        const request = {
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        };
        const failed = await h.object.approveChanges(request);
        expect(failed.approval.status).toBe('failed');
        const retried = await h.object.approveChanges(request);
        expect(retried.approval.status).toBe('completed');
        expect(retried.approval.error).toBeUndefined();
        expect(h.executor.writeApprovedChanges).toHaveBeenCalledTimes(2);
    });

    it('resumes an approval left applying by a Worker restart', async () => {
        const h = harness({ executor: approvalExecutor() });
        const state = await readyForApproval(h);
        const stored = (await h.storage.get<CodingDurableSession>('coding-session'))!;
        stored.approval = { ...stored.approval!, status: 'applying', applyingAt: 1_000 };
        await h.storage.put('coding-session', stored);
        const result = await h.object.approveChanges({
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        });
        expect(result.approval.status).toBe('completed');
        expect(h.executor.writeApprovedChanges).toHaveBeenCalledTimes(1);
    });

    it('marks an expired approval when status is read', async () => {
        let now = 1_000;
        const h = harness({ executor: approvalExecutor(), now: () => now });
        await readyForApproval(h);
        now += 900_001;
        const state = await h.object.getState('10', '10');
        expect(state?.approval?.status).toBe('expired');
        expect(h.executor.writeApprovedChanges).not.toHaveBeenCalled();
    });

    it('expires approvals after the configured period', async () => {
        let now = 1_000;
        const h = harness({ executor: approvalExecutor(), now: () => now });
        const state = await readyForApproval(h);
        now += 900_001;
        const result = await h.object.approveChanges({
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        });
        expect(result.approval.status).toBe('expired');
        expect(h.executor.writeApprovedChanges).not.toHaveBeenCalled();
    });

    it('invalidates an approval when the sandbox diff changes', async () => {
        let current = proposedChangeSet();
        const h = harness({ executor: approvalExecutor({ changes: async () => current }) });
        const state = await readyForApproval(h);
        current = proposedChangeSet({ diffHash: '3'.repeat(64), diff: 'changed\n' });
        const result = await h.object.approveChanges({
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        });
        expect(result.approval.status).toBe('stale');
        expect(h.executor.writeApprovedChanges).not.toHaveBeenCalled();
    });

    it('preserves the proposed change set when a GitHub write fails', async () => {
        const h = harness({
            executor: approvalExecutor({
                write: async () => {
                    throw new Error('GitHub API unavailable');
                },
            }),
        });
        const state = await readyForApproval(h);
        const request = {
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        };
        const result = await h.object.approveChanges(request);
        expect(result.approval.status).toBe('failed');
        expect(result.approval.error).toContain('GitHub API unavailable');
        const review = await h.object.reviewApproval(request);
        expect(review.changeSet?.diff).toContain('+new');
        expect(h.executor.writeApprovedChanges).toHaveBeenCalledTimes(1);
    });

    it('invalidates a pending approval when a new instruction starts', async () => {
        const h = harness({ executor: approvalExecutor() });
        const state = await readyForApproval(h);
        await h.object.enqueueInstruction({ userId: '10', chatId: '10', instruction: 'change it again' });
        const next = await h.object.getState('10', '10');
        expect(next?.approval?.status).toBe('stale');
        const result = await h.object.approveChanges({
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        });
        expect(result.approval.status).toBe('stale');
        expect(h.executor.writeApprovedChanges).not.toHaveBeenCalled();
    });

    it('serializes concurrent approvals across simulated Worker isolates', async () => {
        const changes = new CodingChangeStore(new MemoryKV(), 3_600);
        const executor = approvalExecutor();
        const h1 = harness({ executor, changes });
        const state = await readyForApproval(h1);
        const h2 = harness({ storage: h1.storage, executor, changes });
        const request = {
            userId: '10',
            chatId: '10',
            approvalId: state.approval!.id,
            nonce: state.approval!.nonce,
        };
        const [first, second] = await Promise.all([
            h1.object.approveChanges(request),
            h2.object.approveChanges(request),
        ]);
        expect([first.approval.status, second.approval.status]).toContain('completed');
        expect([first.approval.status, second.approval.status].filter(status => status === 'completed')).toHaveLength(
            1,
        );
        expect(executor.writeApprovedChanges).toHaveBeenCalledTimes(1);
    });

    it('sends a complete diff as a document when it is too large for a message', async () => {
        const large = proposedChangeSet({ diff: `diff --git a/src/a.ts b/src/a.ts\n${'+line\n'.repeat(1_000)}` });
        const h = harness({ executor: approvalExecutor({ changes: async () => large }) });
        await readyForApproval(h);
        expect(h.notifier.documents).toHaveLength(1);
        expect(new TextDecoder().decode(h.notifier.documents[0].content)).toContain('+line');
        expect(h.notifier.documents[0].caption).toContain('Changes are ready for review');
    });

    it('falls back to a text approval message when the document upload fails', async () => {
        const large = proposedChangeSet({ diff: `diff --git a/src/a.ts b/src/a.ts\n${'+line\n'.repeat(1_000)}` });
        const notifier = new FakeNotifier();
        notifier.sendDocument = async () => undefined;
        const h = harness({ executor: approvalExecutor({ changes: async () => large }), notifier });
        await readyForApproval(h);
        expect(h.notifier.messages.some(message => message.text.includes('Changes are ready for review'))).toBe(true);
        expect(h.notifier.messages.find(message => message.keyboard)).toBeDefined();
    });
});
