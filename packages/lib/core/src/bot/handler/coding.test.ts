import type * as Telegram from 'telegram-bot-api-types';
import { describe, expect, it, vi } from 'vitest';
import type { CodingSessionManager } from '../coding/manager';
import { CodingSessionError } from '../coding/types';
import { context, fakeGithub, fakeReply, message, session } from '../coding/test-helpers';
import { CodingCallbackHandler, CodingMessageHandler } from './coding';

function manager(overrides: Partial<CodingSessionManager> = {}): CodingSessionManager {
    return {
        getSession: vi.fn(async () => null),
        startSession: vi.fn(async () => session()),
        stopSession: vi.fn(async () => session()),
        statusLabel: vi.fn(() => 'idle (awaiting input)'),
        runInstruction: vi.fn(async () => ({ text: 'done', steps: 1, stopReason: 'complete' as const })),
        ...overrides,
    } as unknown as CodingSessionManager;
}

function callbackUpdate(data: string, fromId = 10, chatId = 10, chatType = 'private'): Telegram.Update {
    return {
        update_id: 1,
        callback_query: {
            id: 'cb-1',
            from: { id: fromId, is_bot: false, first_name: 'User' },
            chat_instance: 'instance',
            data,
            message: message({
                chat: { id: chatId, type: chatType as Telegram.Chat['type'] },
                from: { id: 999, is_bot: true, first_name: 'Bot' },
                text: 'Select a repository',
            }),
        },
    } as Telegram.Update;
}

function callbackReply() {
    const fake = fakeReply();
    return { ...fake, factory: () => fake.reply };
}

describe('CodingCallbackHandler', () => {
    it('starts a coding session for an authorized repository selection', async () => {
        const fake = callbackReply();
        const start = vi.fn(async () => session());
        const handler = new CodingCallbackHandler({
            manager: manager({ startSession: start }),
            github: fakeGithub({ repositories: ['octo/repo'] }),
            reply: fake.factory,
        });

        const response = await handler.handle(callbackUpdate('code:repo:0'), context());
        expect(response?.status).toBe(200);
        expect(start).toHaveBeenCalledWith('10', '10', 'octo/repo');
        expect(fake.answers).toContain('Starting coding session');
        expect(fake.texts.at(-1)).toContain('Repository loaded');
    });

    it('rejects callbacks from a different user or a group', async () => {
        const mismatch = callbackReply();
        const mismatchStart = vi.fn();
        await new CodingCallbackHandler({
            manager: manager({ startSession: mismatchStart }),
            github: fakeGithub(),
            reply: mismatch.factory,
        }).handle(callbackUpdate('code:repo:0', 11, 10), context());
        expect(mismatchStart).not.toHaveBeenCalled();
        expect(mismatch.answers[0]).toContain('does not belong');

        const group = callbackReply();
        const groupStart = vi.fn();
        await new CodingCallbackHandler({
            manager: manager({ startSession: groupStart }),
            github: fakeGithub(),
            reply: group.factory,
        }).handle(callbackUpdate('code:repo:0', 10, 10, 'group'), context());
        expect(groupStart).not.toHaveBeenCalled();
        expect(group.answers[0]).toContain('private chats');
    });

    it('rejects stale, unauthorized and duplicate repository selections', async () => {
        const stale = callbackReply();
        const staleStart = vi.fn();
        await new CodingCallbackHandler({
            manager: manager({ startSession: staleStart }),
            github: fakeGithub({ repositories: ['octo/repo'] }),
            reply: stale.factory,
        }).handle(callbackUpdate('code:repo:4'), context());
        expect(staleStart).not.toHaveBeenCalled();
        expect(stale.answers[0]).toContain('list changed');

        const unauthorized = callbackReply();
        const unauthorizedStart = vi.fn();
        await new CodingCallbackHandler({
            manager: manager({ startSession: unauthorizedStart }),
            github: fakeGithub({ repositories: [] }),
            reply: unauthorized.factory,
        }).handle(callbackUpdate('code:repo:0'), context());
        expect(unauthorizedStart).not.toHaveBeenCalled();

        const duplicate = callbackReply();
        const duplicateStart = vi.fn();
        await new CodingCallbackHandler({
            manager: manager({ getSession: vi.fn(async () => session()), startSession: duplicateStart }),
            github: fakeGithub(),
            reply: duplicate.factory,
        }).handle(callbackUpdate('code:repo:0'), context());
        expect(duplicateStart).not.toHaveBeenCalled();
        expect(duplicate.texts[0]).toContain('already active');
    });

    it('ignores non-coding callbacks', async () => {
        const handler = new CodingCallbackHandler({
            manager: manager(),
            github: fakeGithub(),
            reply: callbackReply().factory,
        });
        await expect(handler.handle(callbackUpdate('m:0:0'), context())).resolves.toBeNull();
    });
});

describe('CodingMessageHandler', () => {
    it('routes only active coding sessions and sends progress plus final result', async () => {
        const fake = fakeReply();
        const run = vi.fn(async () => ({ text: 'final answer', steps: 2, stopReason: 'complete' as const }));
        const handler = new CodingMessageHandler({
            manager: manager({ getSession: vi.fn(async () => session()), runInstruction: run }),
            reply: () => fake.reply,
        });

        const response = await handler.handle(message({ text: 'find the bug' }), context());
        expect(response?.status).toBe(200);
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ repository: 'octo/repo' }), 'find the bug');
        expect(fake.texts[0]).toContain('Working on octo/repo');
        expect(fake.texts[1]).toBe('final answer');
    });

    it('splits long final results before sending', async () => {
        const fake = fakeReply();
        const long = 'x'.repeat(9000);
        const handler = new CodingMessageHandler({
            manager: manager({
                getSession: vi.fn(async () => session()),
                runInstruction: vi.fn(async () => ({ text: long, steps: 1, stopReason: 'complete' as const })),
            }),
            reply: () => fake.reply,
        });
        await handler.handle(message({ text: 'work' }), context());
        const resultParts = fake.texts.filter(text => text !== 'Working on octo/repo...');
        expect(resultParts.length).toBeGreaterThan(1);
        expect(resultParts.every(part => part.length <= 4096)).toBe(true);
        expect(resultParts.join('')).toBe(long);
    });

    it('leaves ordinary chat alone when there is no session', async () => {
        const handler = new CodingMessageHandler({
            manager: manager({ getSession: vi.fn(async () => null) }),
            reply: () => fakeReply().reply,
        });
        await expect(handler.handle(message({ text: 'ordinary chat' }), context())).resolves.toBeNull();
    });

    it('does not run while busy and rejects non-text messages', async () => {
        const running = fakeReply();
        const run = vi.fn();
        const runningHandler = new CodingMessageHandler({
            manager: manager({ getSession: vi.fn(async () => session({ status: 'running' })), runInstruction: run }),
            reply: () => running.reply,
        });
        await runningHandler.handle(message({ text: 'more work' }), context());
        expect(run).not.toHaveBeenCalled();
        expect(running.texts[0]).toContain('already working');

        const photo = fakeReply();
        const photoHandler = new CodingMessageHandler({
            manager: manager({ getSession: vi.fn(async () => session()) }),
            reply: () => photo.reply,
        });
        await photoHandler.handle(
            message({
                text: undefined,
                photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 1, height: 1 }],
            }),
            context(),
        );
        expect(photo.texts[0]).toContain('text instructions only');
    });

    it('handles cancellation without sending a second failure message', async () => {
        const fake = fakeReply();
        const handler = new CodingMessageHandler({
            manager: manager({
                getSession: vi.fn().mockResolvedValueOnce(session()).mockResolvedValueOnce(null),
                runInstruction: vi.fn(async () => {
                    throw new CodingSessionError('cancelled', 'Coding operation cancelled');
                }),
            }),
            reply: () => fake.reply,
        });
        const response = await handler.handle(message({ text: 'work' }), context());
        expect(response?.status).toBe(200);
        expect(fake.texts.some(text => text.includes('failed'))).toBe(false);
    });

    it('reports agent failures while keeping the session available', async () => {
        const fake = fakeReply();
        const handler = new CodingMessageHandler({
            manager: manager({
                getSession: vi.fn(async () => session()),
                runInstruction: vi.fn(async () => {
                    throw new CodingSessionError('agent', 'model unavailable');
                }),
            }),
            reply: () => fake.reply,
        });
        await handler.handle(message({ text: 'work' }), context());
        expect(fake.texts.at(-1)).toContain('model unavailable');
    });
});
