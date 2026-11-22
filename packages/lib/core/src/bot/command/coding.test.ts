import { describe, expect, it, vi } from 'vitest';
import type { CodingSessionManager } from '../coding/manager';
import type { CodingSessionState } from '../coding/types';
import { context, fakeGithub, fakeReply, message, session } from '../coding/test-helpers';
import { CodeCommandHandler, CodeStatusCommandHandler, CodeStopCommandHandler } from './coding';

function manager(overrides: Partial<CodingSessionManager> = {}): CodingSessionManager {
    return {
        getSession: vi.fn(async () => null),
        startSession: vi.fn(async () => session()),
        stopSession: vi.fn(async () => session()),
        statusLabel: vi.fn(() => 'idle (awaiting input)'),
        runInstruction: vi.fn(),
        ...overrides,
    } as unknown as CodingSessionManager;
}

function replyFactory() {
    const fake = fakeReply();
    return { ...fake, factory: () => fake.reply };
}

describe('CodeCommandHandler', () => {
    it('lists authorized repositories as inline keyboard buttons', async () => {
        const fake = replyFactory();
        const github = fakeGithub({ repositories: ['octo/repo', 'octo/other'] });
        const handler = new CodeCommandHandler({
            manager: manager(),
            github,
            reply: fake.factory,
        });

        const response = await handler.handle(message({ text: '/code' }), '', context());
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
            manager: manager({ getSession: vi.fn(async () => session()) }),
            github: fakeGithub(),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code' }), '', context());
        expect(fake.texts[0]).toContain('already active');
        expect(fake.keyboards).toHaveLength(0);
    });

    it('rejects groups and users with no authorized repositories', async () => {
        const fake = replyFactory();
        const groupHandler = new CodeCommandHandler({
            manager: manager(),
            github: fakeGithub(),
            reply: fake.factory,
        });
        await groupHandler.handle(
            message({ chat: { id: 10, type: 'group' }, from: { id: 10, is_bot: false, first_name: 'U' } }),
            '',
            context(),
        );
        expect(fake.texts[0]).toContain('private chats');

        const empty = replyFactory();
        const handler = new CodeCommandHandler({
            manager: manager(),
            github: fakeGithub({ repositories: [] }),
            reply: empty.factory,
        });
        await handler.handle(message({ text: '/code' }), '', context());
        expect(empty.texts[0]).toContain('No GitHub repositories');
    });
});

describe('CodeStatusCommandHandler', () => {
    it('reports running and idle statuses', async () => {
        const fake = replyFactory();
        const running = session({ status: 'running' });
        const handler = new CodeStatusCommandHandler({
            manager: manager({
                getSession: vi.fn(async () => running),
                statusLabel: vi.fn(() => 'running'),
            }),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code_status' }), '', context());
        expect(fake.texts[0]).toContain('Status: running');
        expect(fake.texts[0]).toContain('Repository: octo/repo');

        const idle = replyFactory();
        const idleHandler = new CodeStatusCommandHandler({
            manager: manager({
                getSession: vi.fn(async () => session({ status: 'awaiting_input' })),
                statusLabel: vi.fn(() => 'idle (awaiting input)'),
            }),
            reply: idle.factory,
        });
        await idleHandler.handle(message({ text: '/code_status' }), '', context());
        expect(idle.texts[0]).toContain('idle (awaiting input)');
    });

    it('reports when there is no session', async () => {
        const fake = replyFactory();
        const handler = new CodeStatusCommandHandler({ manager: manager(), reply: fake.factory });
        await handler.handle(message({ text: '/code_status' }), '', context());
        expect(fake.texts[0]).toContain('No active coding session');
    });
});

describe('CodeStopCommandHandler', () => {
    it('stops the active session', async () => {
        const fake = replyFactory();
        const stopped = vi.fn(async () => session() as CodingSessionState);
        const handler = new CodeStopCommandHandler({
            manager: manager({ stopSession: stopped }),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code_stop' }), '', context());
        expect(stopped).toHaveBeenCalledWith('10', '10');
        expect(fake.texts[0]).toContain('Coding session stopped');
    });

    it('handles a missing session safely', async () => {
        const fake = replyFactory();
        const handler = new CodeStopCommandHandler({
            manager: manager({ stopSession: vi.fn(async () => null) }),
            reply: fake.factory,
        });
        await handler.handle(message({ text: '/code_stop' }), '', context());
        expect(fake.texts[0]).toContain('No active coding session');
    });
});
