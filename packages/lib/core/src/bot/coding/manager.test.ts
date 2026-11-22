import type { ChatAgent, ToolRegistry } from '@chatgpt-telegram-workers/agent';
import { describe, expect, it } from 'vitest';
import type { SandboxScope } from '@chatgpt-telegram-workers/sandbox';
import { CodingSessionManager } from './manager';
import { CodingSessionStore } from './session';
import { CodingSessionError } from './types';
import { MemoryKV, deferred, fakeAgent, fakeGithub, sandboxFor } from './test-helpers';

describe('CodingSessionManager', () => {
    it('starts a sandbox session and checks out the authorized repository', async () => {
        const kv = new MemoryKV();
        const store = new CodingSessionStore(
            kv,
            () => 1_000,
            1800,
            () => 'session-1',
        );
        const scopes: SandboxScope[] = [];
        const checkouts: string[] = [];
        const sandbox = await sandboxFor({ userId: '10', repository: 'octo/repo', sessionId: 'session-1' });
        const manager = new CodingSessionManager({
            store,
            sandboxFactory: async scope => {
                scopes.push(scope);
                return sandbox;
            },
            githubFactory: () => fakeGithub({ onCheckout: repository => checkouts.push(repository) }),
            agentFactory: () => fakeAgent(),
        });

        const session = await manager.startSession('10', '10', 'octo/repo');
        expect(session).toMatchObject({ status: 'awaiting_input', repository: 'octo/repo' });
        expect(scopes).toEqual([{ userId: '10', repository: 'octo/repo', sessionId: 'session-1' }]);
        expect(checkouts).toEqual(['octo/repo']);
        expect(await manager.getSession('20', '20')).toBeNull();
    });

    it('runs instructions with coding and GitHub tools and stores coding-only history', async () => {
        const kv = new MemoryKV();
        const store = new CodingSessionStore(
            kv,
            () => 1_000,
            1800,
            () => 'session-1',
        );
        const sandbox = await sandboxFor({ userId: '10', repository: 'octo/repo', sessionId: 'session-1' });
        const requests: any[] = [];
        const agent = fakeAgent('fixed') as ChatAgent;
        agent.completeWithTools = async (messages, tools, options) => {
            requests.push({ messages, tools, options });
            return {
                text: 'fixed',
                messages: [],
                steps: 1,
                toolCalls: [],
                toolResults: [],
                stopReason: 'complete',
            };
        };
        const manager = new CodingSessionManager({
            store,
            sandboxFactory: async () => sandbox,
            githubFactory: () => fakeGithub(),
            agentFactory: () => agent,
        });

        const session = await manager.startSession('10', '10', 'octo/repo');
        const result = await manager.runInstruction(session, 'Inspect the project.');
        expect(result.text).toBe('fixed');
        expect(requests).toHaveLength(1);
        expect(requests[0].options.access).toMatchObject({
            userId: '10',
            chatId: '10',
            repository: 'octo/repo',
            sessionId: 'session-1',
            permissions: ['coding'],
        });
        const names = (requests[0].tools as ToolRegistry)
            .definitions(requests[0].options.access)
            .map(tool => tool.name);
        expect(names).toEqual(expect.arrayContaining(['shell_exec', 'repo_checkout']));
        expect(kv.values.has('coding:history:10:10:session-1')).toBe(true);
        expect(kv.values.has('history:10')).toBe(false);
    });

    it('rejects unauthorized repositories and cleans up the session', async () => {
        const store = new CodingSessionStore(
            new MemoryKV(),
            () => 1_000,
            1800,
            () => 'session-1',
        );
        const manager = new CodingSessionManager({
            store,
            sandboxFactory: async () => sandboxFor({ userId: '10', repository: 'octo/repo', sessionId: 'session-1' }),
            githubFactory: () => fakeGithub({ repositories: [] }),
            agentFactory: () => fakeAgent(),
        });
        await expect(manager.startSession('10', '10', 'octo/repo')).rejects.toBeInstanceOf(CodingSessionError);
        await expect(manager.getSession('10', '10')).resolves.toBeNull();
    });

    it('maps sandbox initialization failures', async () => {
        const store = new CodingSessionStore(
            new MemoryKV(),
            () => 1_000,
            1800,
            () => 'session-1',
        );
        const manager = new CodingSessionManager({
            store,
            sandboxFactory: async () => {
                throw new Error('container unavailable');
            },
            githubFactory: () => fakeGithub(),
            agentFactory: () => fakeAgent(),
        });
        await expect(manager.startSession('10', '10', 'octo/repo')).rejects.toMatchObject({ code: 'sandbox' });
        await expect(manager.getSession('10', '10')).resolves.toBeNull();
    });

    it('maps repository checkout failures', async () => {
        const store = new CodingSessionStore(
            new MemoryKV(),
            () => 1_000,
            1800,
            () => 'session-1',
        );
        const manager = new CodingSessionManager({
            store,
            sandboxFactory: async () => sandboxFor({ userId: '10', repository: 'octo/repo', sessionId: 'session-1' }),
            githubFactory: () => fakeGithub({ checkoutError: new Error('repository unavailable') }),
            agentFactory: () => fakeAgent(),
        });
        await expect(manager.startSession('10', '10', 'octo/repo')).rejects.toMatchObject({ code: 'checkout' });
        await expect(manager.getSession('10', '10')).resolves.toBeNull();
    });

    it('prevents duplicate active sessions', async () => {
        const store = new CodingSessionStore(
            new MemoryKV(),
            () => 1_000,
            1800,
            () => 'session-1',
        );
        let created = 0;
        const manager = new CodingSessionManager({
            store,
            sandboxFactory: async () => {
                created++;
                return sandboxFor({ userId: '10', repository: 'octo/repo', sessionId: 'session-1' });
            },
            githubFactory: () => fakeGithub(),
            agentFactory: () => fakeAgent(),
        });
        await manager.startSession('10', '10', 'octo/repo');
        await expect(manager.startSession('10', '10', 'octo/repo')).rejects.toMatchObject({ code: 'active' });
        expect(created).toBe(1);
    });

    it('stops a running operation and cancels it', async () => {
        const store = new CodingSessionStore(
            new MemoryKV(),
            () => 1_000,
            1800,
            () => 'session-1',
        );
        const sandbox = await sandboxFor({ userId: '10', repository: 'octo/repo', sessionId: 'session-1' });
        const waiting = deferred<never>();
        const agent = fakeAgent() as ChatAgent;
        agent.completeWithTools = async (_messages, _tools, options) => {
            await new Promise((_, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
            return waiting.promise;
        };
        const manager = new CodingSessionManager({
            store,
            sandboxFactory: async () => sandbox,
            githubFactory: () => fakeGithub(),
            agentFactory: () => agent,
        });
        const session = await manager.startSession('10', '10', 'octo/repo');
        const run = manager.runInstruction(session, 'long task');
        await new Promise(resolve => setTimeout(resolve, 0));
        await manager.stopSession('10', '10');
        await expect(run).rejects.toMatchObject({ code: 'cancelled' });
        await expect(manager.getSession('10', '10')).resolves.toBeNull();
    });
});
