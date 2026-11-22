import { describe, expect, it, vi } from 'vitest';
import type { CodingAgentExecutor } from './executor';
import type { CodingHistoryStore } from './history';
import type { CodingJobNotifier } from './notifier';
import {
    CodingSessionDurableObject,
    type CodingSessionDurableEnv,
    type CodingSessionDurableObjectOptions,
    type CodingSessionDurableStorage,
} from './durable-object';
import { deferred } from './test-helpers';
import type { CodingTelegramTarget } from './types';

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
    readonly messages: { target: CodingTelegramTarget | undefined; text: string }[] = [];
    fail = false;

    async notify(target: CodingTelegramTarget | undefined, text: string): Promise<number | undefined> {
        if (this.fail) {
            throw new Error('telegram unavailable');
        }
        this.messages.push({ target, text });
        return target?.messageId ?? 100 + this.messages.length;
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
    let id = 0;
    const object = new CodingSessionDurableObject(
        ctx,
        {} as CodingSessionDurableEnv,
        {
            executor,
            history: history as unknown as CodingHistoryStore,
            notifier,
            now: options.now ?? (() => 1_000),
            idFactory: options.idFactory ?? (() => `id-${++id}`),
            staleMs: options.staleMs,
            heartbeatMs: options.heartbeatMs,
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
