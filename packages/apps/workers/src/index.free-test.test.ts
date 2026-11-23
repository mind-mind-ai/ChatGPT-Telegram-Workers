import {
    cloneDefaultConfig,
    ENV,
    GLOBAL_CONFIG_KEY,
    WorkerContext,
    handleUpdate,
} from '@chatgpt-telegram-workers/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.free-test';

const BOT_TOKEN = 'free-test-secret-token';

type TestMessage = Record<string, unknown>;

function message(overrides: TestMessage = {}): TestMessage {
    return {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 10, type: 'private' },
        from: { id: 10, is_bot: false, first_name: 'User' },
        text: 'hello',
        ...overrides,
    };
}

function webhook(body: unknown, path = `/telegram/${BOT_TOKEN}/webhook`): Request {
    return new Request(`https://worker.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

function harness(
    options: {
        customCommands?: ReturnType<typeof cloneDefaultConfig>['customCommands'];
        session?: Record<string, unknown> | null;
    } = {},
) {
    const config = cloneDefaultConfig();
    config.settings.allowAllUsers = true;
    config.settings.streamMode = false;
    config.customCommands = options.customCommands ?? [];

    const kv = {
        get: async (key: string) => (key === GLOBAL_CONFIG_KEY ? JSON.stringify(config) : null),
        put: async () => undefined,
        delete: async () => undefined,
    };
    const createSession = vi.fn(async () => {
        throw new Error('createSession must not be called in the free-test worker');
    });
    const enqueueInstruction = vi.fn(async () => undefined);
    const getState = vi.fn(async () => options.session ?? null);
    const getByName = vi.fn(() => ({
        getState,
        createSession,
        enqueueInstruction,
    }));

    return {
        env: {
            DATABASE: kv as never,
            CODING_SESSION: { getByName } as never,
            TELEGRAM_TOKEN: BOT_TOKEN,
        },
        createSession,
        enqueueInstruction,
        getByName,
    };
}

describe('Free-test Worker fetch entrypoint', () => {
    let warnSpy: ReturnType<typeof vi.fn>;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        ENV.CONFIG = cloneDefaultConfig();
        ENV.DATABASE = null as never;
        ENV.CODING_SESSION = null;
        ENV.getConfigStore().invalidate();
        warnSpy = vi.fn();
        fetchSpy = vi.fn(
            async () =>
                new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        vi.stubGlobal('console', { ...console, warn: warnSpy, error: vi.fn() });
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        ENV.DATABASE = null as never;
        ENV.CODING_SESSION = null;
    });

    it('passes a normal Telegram message through the application', async () => {
        const h = harness();
        const response = await worker.fetch(
            webhook({ update_id: 1, message: message({ text: 'ordinary chat' }) }),
            h.env,
        );

        expect(response.status).toBe(200);
        expect(h.getByName).toHaveBeenCalled();
        expect(h.createSession).not.toHaveBeenCalled();
    });

    it('blocks a custom command that expands to /code before command handling', async () => {
        const h = harness({
            customCommands: [
                {
                    id: 'startcode',
                    command: '/startcode',
                    description: 'start coding',
                    scope: ['private'],
                    value: '/code',
                    enabled: true,
                },
            ],
            session: { status: 'awaiting_input', repository: 'owner/repo' },
        });
        const response = await worker.fetch(webhook({ update_id: 1, message: message({ text: '/startcode' }) }), h.env);

        expect(response.status).toBe(200);
        expect(h.enqueueInstruction).toHaveBeenCalledWith(expect.objectContaining({ instruction: '/startcode' }));
        expect(h.createSession).not.toHaveBeenCalled();
    });

    it('handles a normal Telegram message through the safehook route', async () => {
        const h = harness();
        const response = await worker.fetch(
            webhook({ update_id: 1, message: message({ text: 'ordinary chat' }) }, `/telegram/${BOT_TOKEN}/safehook`),
            h.env,
        );

        expect(response.status).toBe(200);
        expect(h.getByName).toHaveBeenCalled();
        expect(h.createSession).not.toHaveBeenCalled();
    });

    it('accepts null text and caption fields without rejecting the message', async () => {
        const h = harness();
        const response = await worker.fetch(
            webhook({ update_id: 1, message: message({ text: null, caption: null }) }),
            h.env,
        );

        expect(response.status).toBe(200);
        expect(h.createSession).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalledWith(
            '[telegram] ignored invalid update',
            expect.objectContaining({ reason: 'invalid-text' }),
        );
        expect(warnSpy).not.toHaveBeenCalledWith(
            '[telegram] ignored invalid update',
            expect.objectContaining({ reason: 'invalid-caption' }),
        );
    });

    it('blocks /code before the application can start a session', async () => {
        const h = harness();
        const response = await worker.fetch(webhook({ update_id: 1, message: message({ text: '/code' }) }), h.env);

        expect(response.status).toBe(200);
        expect(h.getByName).not.toHaveBeenCalled();
        expect(h.createSession).not.toHaveBeenCalled();
    });

    it('blocks coding callbacks before the application can start a session', async () => {
        const h = harness();
        const response = await worker.fetch(
            webhook({
                update_id: 1,
                callback_query: {
                    id: 'cb',
                    chat_instance: 'instance',
                    from: { id: 10, is_bot: false, first_name: 'User' },
                    data: 'code:repo:0',
                    message: message(),
                },
            }),
            h.env,
        );

        expect(response.status).toBe(200);
        expect(h.getByName).not.toHaveBeenCalled();
        expect(h.createSession).not.toHaveBeenCalled();
    });

    it('handles a normal non-coding callback without creating a session', async () => {
        const h = harness();
        const response = await worker.fetch(
            webhook({
                update_id: 1,
                callback_query: {
                    id: 'cb',
                    chat_instance: 'instance',
                    from: { id: 10, is_bot: false, first_name: 'User' },
                    data: 'm:0:0',
                    message: message(),
                },
            }),
            h.env,
        );

        expect(response.status).toBe(200);
        expect(h.createSession).not.toHaveBeenCalled();
        expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('answerCallbackQuery'))).toBe(true);
    });

    it('handles malformed webhook JSON safely', async () => {
        const h = harness();
        const response = await worker.fetch(webhook('{not-json'), h.env);

        expect(response.status).toBe(200);
        expect(h.createSession).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
            '[free-test] telegram update rejected',
            expect.objectContaining({ reason: 'invalid-json' }),
        );
    });

    it('logs an invalid message through the shared update handler', async () => {
        const h = harness();
        ENV.merge(h.env);
        await handleUpdate(BOT_TOKEN, { update_id: 1, message: {} } as never);
        expect(ENV.DATABASE).toBeTruthy();
        expect(warnSpy).toHaveBeenCalledWith(
            '[telegram] ignored invalid update',
            expect.objectContaining({ reason: 'invalid-chat' }),
        );
    });

    it('rethrows unexpected TypeErrors instead of treating them as malformed updates', async () => {
        const h = harness();
        ENV.merge(h.env);
        const fromSpy = vi.spyOn(WorkerContext, 'from').mockImplementation(() => {
            throw new TypeError('programming bug');
        });

        await expect(handleUpdate(BOT_TOKEN, { update_id: 1, message: message() } as never)).rejects.toThrow(
            'programming bug',
        );
        fromSpy.mockRestore();
    });

    it('logs an invalid message field through the shared update handler', async () => {
        const h = harness();
        ENV.merge(h.env);
        await handleUpdate(BOT_TOKEN, {
            update_id: 1,
            message: { chat: { id: 10, type: 'private' }, text: 123 },
        } as never);
        expect(warnSpy).toHaveBeenCalledWith(
            '[telegram] ignored invalid update',
            expect.objectContaining({ reason: 'invalid-text' }),
        );
    });

    it('does not silently ignore a token configuration error', async () => {
        const h = harness();
        ENV.merge(h.env);
        const response = await handleUpdate('wrong-token', {
            update_id: 1,
            message: message(),
        } as never);
        expect(response?.status).toBe(403);
        expect(warnSpy).toHaveBeenCalledWith(
            '[telegram] rejected update',
            expect.objectContaining({ reason: 'token-not-allowed' }),
        );
    });

    it('handles a malformed Telegram update shape safely', async () => {
        const h = harness();
        const response = await worker.fetch(webhook({ update_id: 1, message: {} }), h.env);

        expect(response.status).toBe(200);
        expect(h.createSession).not.toHaveBeenCalled();
        expect(ENV.DATABASE).toBeTruthy();
        expect(warnSpy).toHaveBeenCalledWith(
            '[telegram] ignored invalid update',
            expect.objectContaining({ reason: 'invalid-chat' }),
        );
    });

    it('blocks coding text in edited, channel, business and caption updates', async () => {
        const h = harness();
        const updates = [
            { edited_message: message({ text: '/code' }) },
            { channel_post: message({ text: '/code_status' }) },
            { edited_channel_post: message({ text: '/code_stop' }) },
            { business_message: message({ text: '/code' }) },
            { edited_business_message: message({ text: '/code' }) },
            { message: message({ text: undefined, caption: '/code' }) },
        ];

        for (const update of updates) {
            const response = await worker.fetch(webhook({ update_id: 1, ...update }), h.env);
            expect(response.status).toBe(200);
        }
        expect(h.getByName).not.toHaveBeenCalled();
        expect(h.createSession).not.toHaveBeenCalled();
    });

    it('does not log tokens or private message content when rejecting coding updates', async () => {
        const h = harness();
        await worker.fetch(webhook({ update_id: 1, message: message({ text: '/code' }) }), h.env);

        const logged = JSON.stringify(warnSpy.mock.calls);
        expect(logged).not.toContain(BOT_TOKEN);
        expect(logged).not.toContain('/code');
        expect(logged).toContain('coding-command-or-callback');
    });

    it('returns 404 for a non-webhook path without creating a session', async () => {
        const h = harness();
        const response = await worker.fetch(webhook({ update_id: 1 }, '/not-telegram'), h.env);

        expect(response.status).toBe(404);
        expect(h.createSession).not.toHaveBeenCalled();
    });
});
