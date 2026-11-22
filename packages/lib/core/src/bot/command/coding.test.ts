import { describe, expect, it, vi } from 'vitest';
import {
    coordinatorFactory,
    durableJob,
    durableSession,
    fakeCoordinator,
    fakeGithub,
    fakeReply,
    message,
} from '../coding/test-helpers';
import { CodeCommandHandler, CodeStatusCommandHandler, CodeStopCommandHandler } from './coding';

function replyFactory() {
    const fake = fakeReply();
    return { ...fake, factory: () => fake.reply };
}

describe('CodeCommandHandler', () => {
    it('lists authorized repositories as inline keyboard buttons', async () => {
        const fake = replyFactory();
        const github = fakeGithub({ repositories: ['octo/repo', 'octo/other'] });
        const handler = new CodeCommandHandler({
            coordinator: coordinatorFactory(fakeCoordinator()),
            github,
            reply: fake.factory,
        });

        const response = await handler.handle(message({ text: '/code' }), '', {
            SHARE_CONTEXT: {
                botToken: '123:test',
                botId: 123,
                chatHistoryKey: 'history:10',
                lastMessageKey: 'last:10',
            },
        } as never);
        expect(response.status).toBe(200);
        expect(fake.texts).toEqual(['Select a repository to work on.']);
        expect(fake.keyboards[0].inline_keyboard.map(row => row[0].text)).toEqual(['octo/repo', 'octo/other']);
        expect(fake.keyboards[0].inline_keyboard.map(row => row[0].callback_data)).toEqual([
            'code:repo:0',
            'code:repo:1',
        ]);
    });

    it('does not start a second session or list repositories for an active session', async () => {
        const fake = replyFactory();
        const handler = new CodeCommandHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ getState: vi.fn(async () => durableSession()) })),
            github: fakeGithub(),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code' }), '', { SHARE_CONTEXT: { botToken: '123:test' } } as never);
        expect(fake.texts[0]).toContain('already active');
        expect(fake.keyboards).toHaveLength(0);
    });

    it('rejects groups and users with no authorized repositories', async () => {
        const fake = replyFactory();
        const groupHandler = new CodeCommandHandler({
            coordinator: coordinatorFactory(fakeCoordinator()),
            github: fakeGithub(),
            reply: fake.factory,
        });
        await groupHandler.handle(
            message({ chat: { id: 10, type: 'group' }, from: { id: 10, is_bot: false, first_name: 'U' } }),
            '',
            { SHARE_CONTEXT: { botToken: '123:test' } } as never,
        );
        expect(fake.texts[0]).toContain('private chats');

        const empty = replyFactory();
        const handler = new CodeCommandHandler({
            coordinator: coordinatorFactory(fakeCoordinator()),
            github: fakeGithub({ repositories: [] }),
            reply: empty.factory,
        });
        await handler.handle(message({ text: '/code' }), '', { SHARE_CONTEXT: { botToken: '123:test' } } as never);
        expect(empty.texts[0]).toContain('No GitHub repositories');
    });
});

describe('CodeStatusCommandHandler', () => {
    it('reports meaningful job states and progress', async () => {
        const fake = replyFactory();
        const running = durableSession({
            status: 'running',
            job: durableJob({ kind: 'instruction', status: 'running', progress: 'Running the coding agent...' }),
        });
        const handler = new CodeStatusCommandHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ getState: vi.fn(async () => running) })),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code_status' }), '', {
            SHARE_CONTEXT: { botToken: '123:test' },
        } as never);
        expect(fake.texts[0]).toContain('Status: running');
        expect(fake.texts[0]).toContain('Job: instruction / running');
        expect(fake.texts[0]).toContain('Progress: Running the coding agent...');
        expect(fake.texts[0]).toContain('Repository: octo/repo');

        const idle = replyFactory();
        const idleHandler = new CodeStatusCommandHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ getState: vi.fn(async () => durableSession()) })),
            reply: idle.factory,
        });
        await idleHandler.handle(message({ text: '/code_status' }), '', {
            SHARE_CONTEXT: { botToken: '123:test' },
        } as never);
        expect(idle.texts[0]).toContain('idle (awaiting input)');
        expect(idle.texts[0]).toContain('Job: checkout / completed');
    });

    it('re-attaches approval buttons so a lost notification can be recovered', async () => {
        const fake = replyFactory();
        const approval = {
            id: 'approval1',
            nonce: 'nonce1',
            status: 'pending' as const,
            sessionId: 'session-1',
            jobId: 'job-1',
            userId: '10',
            chatId: '10',
            diffHash: '1'.repeat(64),
            changeKey: 'approval1',
            createdAt: 1_000,
            expiresAt: Date.now() + 60_000,
        };
        const handler = new CodeStatusCommandHandler({
            coordinator: coordinatorFactory(
                fakeCoordinator({ getState: vi.fn(async () => durableSession({ approval })) }),
            ),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code_status' }), '', {
            SHARE_CONTEXT: { botToken: '123:test' },
        } as never);
        expect(fake.texts[0]).toContain('Approval: pending');
        expect(fake.keyboards[0].inline_keyboard.flat().map(button => button.callback_data)).toEqual([
            'code:approval:review:approval1:nonce1',
            'code:approval:approve:approval1:nonce1',
            'code:approval:reject:approval1:nonce1',
        ]);
    });

    it('reports when there is no session', async () => {
        const fake = replyFactory();
        const handler = new CodeStatusCommandHandler({
            coordinator: coordinatorFactory(fakeCoordinator()),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code_status' }), '', {
            SHARE_CONTEXT: { botToken: '123:test' },
        } as never);
        expect(fake.texts[0]).toContain('No active coding session');
    });
});

describe('CodeStopCommandHandler', () => {
    it('does not claim cancellation before confirmation', async () => {
        const fake = replyFactory();
        const stop = vi.fn(async () => durableSession({ status: 'cancelling', cancellationRequested: true }));
        const handler = new CodeStopCommandHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ stopSession: stop })),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code_stop' }), '', { SHARE_CONTEXT: { botToken: '123:test' } } as never);
        expect(stop).toHaveBeenCalledWith('10', '10');
        expect(fake.texts[0]).toContain('still stopping');
        expect(fake.texts[0]).not.toContain('cancelled.');
    });

    it('reports confirmed cancellation', async () => {
        const fake = replyFactory();
        const handler = new CodeStopCommandHandler({
            coordinator: coordinatorFactory(
                fakeCoordinator({
                    stopSession: vi.fn(async () =>
                        durableSession({ status: 'cancelled', cancellationRequested: true }),
                    ),
                }),
            ),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code_stop' }), '', { SHARE_CONTEXT: { botToken: '123:test' } } as never);
        expect(fake.texts[0]).toContain('Coding session cancelled');
    });

    it('handles a missing session safely', async () => {
        const fake = replyFactory();
        const handler = new CodeStopCommandHandler({
            coordinator: coordinatorFactory(fakeCoordinator({ stopSession: vi.fn(async () => null) })),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code_stop' }), '', { SHARE_CONTEXT: { botToken: '123:test' } } as never);
        expect(fake.texts[0]).toContain('No active coding session');
    });
});
