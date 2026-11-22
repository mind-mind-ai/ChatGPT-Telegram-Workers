import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodingTelegramNotifier } from './notifier';

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CodingTelegramNotifier', () => {
    it('sends a new progress message and returns its message id', async () => {
        const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
            response({ ok: true, result: { message_id: 7 } }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const notifier = new CodingTelegramNotifier('123:test');
        await expect(notifier.notify({ chatId: 10 }, 'Preparing repository...')).resolves.toBe(7);
        expect(String(fetchMock.mock.calls[0][0])).toContain('/sendMessage');
    });

    it('edits the existing progress message when possible', async () => {
        const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
            response({ ok: true, result: { message_id: 7 } }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const notifier = new CodingTelegramNotifier('123:test');
        await expect(notifier.notify({ chatId: 10, messageId: 7 }, 'Running...')).resolves.toBe(7);
        expect(String(fetchMock.mock.calls[0][0])).toContain('/editMessageText');
    });

    it('falls back to a new message when editing fails', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(response({ ok: false, description: 'message not found' }, 400))
            .mockResolvedValueOnce(response({ ok: true, result: { message_id: 9 } }));
        vi.stubGlobal('fetch', fetchMock);
        const notifier = new CodingTelegramNotifier('123:test');
        await expect(notifier.notify({ chatId: 10, messageId: 7 }, 'Running...')).resolves.toBe(9);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('splits long final responses into safe Telegram messages', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(response({ ok: true, result: { message_id: 7 } }))
            .mockResolvedValueOnce(response({ ok: true, result: { message_id: 8 } }));
        vi.stubGlobal('fetch', fetchMock);
        const notifier = new CodingTelegramNotifier('123:test');
        await expect(notifier.notify({ chatId: 10 }, 'x'.repeat(5_000))).resolves.toBe(7);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never throws when the Telegram API is unavailable', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('network down');
            }),
        );
        const notifier = new CodingTelegramNotifier('123:test');
        await expect(notifier.notify({ chatId: 10, messageId: 7 }, 'Running...')).resolves.toBe(7);
    });

    it('is a no-op without a token', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const notifier = new CodingTelegramNotifier(undefined);
        await expect(notifier.notify({ chatId: 10 }, 'hello')).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
