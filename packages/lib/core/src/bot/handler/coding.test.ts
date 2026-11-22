import type * as Telegram from 'telegram-bot-api-types';
import { describe, expect, it, vi } from 'vitest';
import { CodingSessionError } from '../coding/types';
import {
    context,
    coordinatorFactory,
    durableJob,
    durableSession,
    fakeCoordinator,
    fakeGithub,
    fakeReply,
    message,
} from '../coding/test-helpers';
import { CodingCallbackHandler, CodingMessageHandler } from './coding';

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
    it('queues a background coding session for an authorized repository selection', async () => {
        const fake = callbackReply();
        const create = vi.fn(async () => durableSession({ status: 'queued' }));
        const handler = new CodingCallbackHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ createSession: create })),
            github: fakeGithub({ repositories: ['octo/repo'] }),
            reply: fake.factory,
        });

        const response = await handler.handle(callbackUpdate('code:repo:0'), context());
        expect(response?.status).toBe(200);
        expect(create).toHaveBeenCalledWith({
            userId: '10',
            chatId: '10',
            repository: 'octo/repo',
            telegram: { chatId: 10 },
        });
        expect(fake.answers).toContain('Starting coding session');
        expect(fake.texts.at(-1)).toContain('loading in the background');
    });

    it('rejects callbacks from a different user or a group', async () => {
        const mismatch = callbackReply();
        const mismatchCreate = vi.fn();
        await new CodingCallbackHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ createSession: mismatchCreate })),
            github: fakeGithub(),
            reply: mismatch.factory,
        }).handle(callbackUpdate('code:repo:0', 11, 10), context());
        expect(mismatchCreate).not.toHaveBeenCalled();
        expect(mismatch.answers[0]).toContain('does not belong');

        const group = callbackReply();
        const groupCreate = vi.fn();
        await new CodingCallbackHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ createSession: groupCreate })),
            github: fakeGithub(),
            reply: group.factory,
        }).handle(callbackUpdate('code:repo:0', 10, 10, 'group'), context());
        expect(groupCreate).not.toHaveBeenCalled();
        expect(group.answers[0]).toContain('private chats');
    });

    it('rejects stale, unauthorized and duplicate repository selections', async () => {
        const stale = callbackReply();
        const staleCreate = vi.fn();
        await new CodingCallbackHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ createSession: staleCreate })),
            github: fakeGithub({ repositories: ['octo/repo'] }),
            reply: stale.factory,
        }).handle(callbackUpdate('code:repo:4'), context());
        expect(staleCreate).not.toHaveBeenCalled();
        expect(stale.answers[0]).toContain('list changed');

        const unauthorized = callbackReply();
        const unauthorizedCreate = vi.fn();
        await new CodingCallbackHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ createSession: unauthorizedCreate })),
            github: fakeGithub({ repositories: [] }),
            reply: unauthorized.factory,
        }).handle(callbackUpdate('code:repo:0'), context());
        expect(unauthorizedCreate).not.toHaveBeenCalled();

        const duplicate = callbackReply();
        const duplicateCreate = vi.fn();
        await new CodingCallbackHandler({
            coordinator: coordinatorFactory(
                fakeCoordinator({
                    getState: vi.fn(async () => durableSession()),
                    createSession: duplicateCreate,
                }),
            ),
            github: fakeGithub(),
            reply: duplicate.factory,
        }).handle(callbackUpdate('code:repo:0'), context());
        expect(duplicateCreate).not.toHaveBeenCalled();
        expect(duplicate.texts[0]).toContain('already active');
    });

    it('ignores non-coding callbacks', async () => {
        const handler = new CodingCallbackHandler({
            coordinator: coordinatorFactory(fakeCoordinator()),
            github: fakeGithub(),
            reply: callbackReply().factory,
        });
        await expect(handler.handle(callbackUpdate('m:0:0'), context())).resolves.toBeNull();
    });
});

describe('CodingMessageHandler', () => {
    it('queues instructions instead of running them in the webhook', async () => {
        const fake = fakeReply();
        const enqueue = vi.fn(async () =>
            durableSession({
                status: 'queued',
                job: durableJob({ kind: 'instruction', status: 'queued', instruction: 'find the bug' }),
            }),
        );
        const handler = new CodingMessageHandler({
            coordinator: coordinatorFactory(
                fakeCoordinator({ getState: vi.fn(async () => durableSession()), enqueueInstruction: enqueue }),
            ),
            reply: () => fake.reply,
        });

        const response = await handler.handle(message({ text: 'find the bug' }), context());
        expect(response?.status).toBe(200);
        expect(enqueue).toHaveBeenCalledWith({
            userId: '10',
            chatId: '10',
            instruction: 'find the bug',
            telegram: { chatId: 10 },
        });
        expect(fake.texts[0]).toContain('Queued the coding job');
    });

    it('leaves ordinary chat alone when there is no session', async () => {
        const handler = new CodingMessageHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ getState: vi.fn(async () => null) })),
            reply: () => fakeReply().reply,
        });
        await expect(handler.handle(message({ text: 'ordinary chat' }), context())).resolves.toBeNull();
    });

    it('does not queue while busy and rejects non-text messages', async () => {
        const running = fakeReply();
        const enqueue = vi.fn();
        const runningHandler = new CodingMessageHandler({
            coordinator: coordinatorFactory(
                fakeCoordinator({
                    getState: vi.fn(async () => durableSession({ status: 'running' })),
                    enqueueInstruction: enqueue,
                }),
            ),
            reply: () => running.reply,
        });
        await runningHandler.handle(message({ text: 'more work' }), context());
        expect(enqueue).not.toHaveBeenCalled();
        expect(running.texts[0]).toContain('already working');

        const photo = fakeReply();
        const photoHandler = new CodingMessageHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ getState: vi.fn(async () => durableSession()) })),
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

    it('reports expired sessions and queue failures', async () => {
        const expired = fakeReply();
        const expiredHandler = new CodingMessageHandler({
            coordinator: coordinatorFactory(
                fakeCoordinator({
                    getState: vi.fn(async () => durableSession()),
                    enqueueInstruction: vi.fn(async () => {
                        throw new CodingSessionError('expired', 'Coding session expired');
                    }),
                }),
            ),
            reply: () => expired.reply,
        });
        await expiredHandler.handle(message({ text: 'work' }), context());
        expect(expired.texts[0]).toContain('expired');

        const failed = fakeReply();
        const failedHandler = new CodingMessageHandler({
            coordinator: coordinatorFactory(
                fakeCoordinator({
                    getState: vi.fn(async () => durableSession()),
                    enqueueInstruction: vi.fn(async () => {
                        throw new CodingSessionError('busy', 'The coding agent is already working');
                    }),
                }),
            ),
            reply: () => failed.reply,
        });
        await failedHandler.handle(message({ text: 'work' }), context());
        expect(failed.texts[0]).toContain('already working');
    });
});
