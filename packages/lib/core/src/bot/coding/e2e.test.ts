import type { ChatAgent, GitHubService, GitHubWriteChangesInput } from '@chatgpt-telegram-workers/agent';
import { ToolRegistry } from '@chatgpt-telegram-workers/agent';
import { MockSandboxClient, createSandboxWorkspace, type SandboxClient } from '@chatgpt-telegram-workers/sandbox';
import type * as Telegram from 'telegram-bot-api-types';
import { describe, expect, it } from 'vitest';
import { CodingCallbackHandler, CodingMessageHandler } from '../handler/coding';
import { CodeCommandHandler } from '../command/coding';
import { CodingAgentExecutor } from './executor';
import { CodingChangeStore, CodingHistoryStore } from './history';
import { type CodingJobNotifier } from './notifier';
import { MemoryKV, context, fakeAgent, fakeReply, message } from './test-helpers';
import {
    CodingSessionDurableObject,
    type CodingSessionDurableEnv,
    type CodingSessionDurableObjectOptions,
    type CodingSessionDurableStorage,
} from './durable-object';
import type { CodingSessionCoordinator, CodingTelegramTarget } from './types';

const BASE_SHA = 'a'.repeat(40);
const BRANCH = 'telegram-agent/session-1';
const COMMIT_SHA = 'b'.repeat(40);

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

class CaptureNotifier implements CodingJobNotifier {
    readonly messages: {
        target: CodingTelegramTarget | undefined;
        text: string;
        keyboard?: unknown;
    }[] = [];
    readonly documents: { filename: string; content: Uint8Array; caption?: string }[] = [];

    async notify(
        target: CodingTelegramTarget | undefined,
        text: string,
        options: { keyboard?: unknown } = {},
    ): Promise<number | undefined> {
        this.messages.push({ target, text, ...(options.keyboard ? { keyboard: options.keyboard } : {}) });
        return target?.messageId ?? 100 + this.messages.length;
    }

    async sendDocument(
        target: CodingTelegramTarget | undefined,
        filename: string,
        content: Uint8Array,
        options: { caption?: string } = {},
    ): Promise<number | undefined> {
        this.documents.push({ filename, content, ...(options.caption ? { caption: options.caption } : {}) });
        return target?.messageId ?? 100 + this.messages.length + this.documents.length;
    }
}

function callbackUpdate(data: string): Telegram.Update {
    return {
        update_id: 1,
        callback_query: {
            id: 'cb-1',
            from: { id: 10, is_bot: false, first_name: 'User' },
            chat_instance: 'instance',
            data,
            message: message({
                chat: { id: 10, type: 'private' },
                from: { id: 999, is_bot: true, first_name: 'Bot' },
                text: 'Select a repository',
            }),
        },
    } as Telegram.Update;
}

function integrationGithub(writeInputs: GitHubWriteChangesInput[]): GitHubService {
    const repository = { owner: 'octo', name: 'repo', fullName: 'octo/repo' };
    return {
        listAuthorizedRepositories: async () => [repository],
        checkoutRepository: async (_repository: string, _access: unknown, sandbox: SandboxClient) => {
            await sandbox.writeFile('src/a.ts', 'old\n');
            return {
                repository,
                ref: 'main',
                commitSha: BASE_SHA,
                filesWritten: 1,
                bytesWritten: 4,
                skippedFiles: 0,
            };
        },
        getBranchHead: async () => ({ ref: 'refs/heads/main', sha: BASE_SHA }),
        downloadRepository: async () => ({
            repository,
            ref: 'main',
            commitSha: BASE_SHA,
            files: [{ path: 'src/a.ts', content: new TextEncoder().encode('old\n'), size: 4 }],
            totalBytes: 4,
            skippedFiles: 0,
        }),
        writeChanges: async (_repository: string, _access: unknown, input: GitHubWriteChangesInput) => {
            writeInputs.push(input);
            return {
                repository,
                baseRef: input.baseRef,
                baseSha: input.expectedBaseSha,
                branch: BRANCH,
                commitSha: COMMIT_SHA,
                filesChanged: input.changes.length,
            };
        },
    } as unknown as GitHubService;
}

function toolAgent(): ChatAgent {
    const base = fakeAgent('Implemented and tests passed.');
    return {
        ...base,
        supportsTools: true,
        completeWithTools: async (_messages, tools: ToolRegistry, options) => {
            const write = await tools.execute(
                {
                    id: 'write-1',
                    name: 'fs_write',
                    arguments: JSON.stringify({ path: 'src/a.ts', content: 'new\n' }),
                },
                options?.access,
            );
            const test = await tools.execute(
                {
                    id: 'test-1',
                    name: 'shell_exec',
                    arguments: JSON.stringify({ command: 'npm test' }),
                },
                options?.access,
            );
            return {
                text: write.isError || test.isError ? 'Tests failed.' : 'Implemented and tests passed.',
                messages: [],
                steps: 2,
                toolCalls: [],
                toolResults: [write, test],
                stopReason: 'complete' as const,
            };
        },
    } as ChatAgent;
}

function coordinatorFor(object: CodingSessionDurableObject): CodingSessionCoordinator {
    return {
        getState: (userId, chatId) => object.getState(userId, chatId),
        createSession: input => object.createSession(input),
        enqueueInstruction: input => object.enqueueInstruction(input),
        stopSession: (userId, chatId) => object.stopSession(userId, chatId),
        reviewApproval: input => object.reviewApproval(input),
        approveChanges: input => object.approveChanges(input),
        rejectChanges: input => object.rejectChanges(input),
    };
}

describe('coding workflow integration', () => {
    it('runs /code, checkout, an agent edit, and an approved GitHub write end to end', async () => {
        const storage = new MemoryDurableStorage();
        const ctx = new FakeContext(storage);
        const notifier = new CaptureNotifier();
        const writeInputs: GitHubWriteChangesInput[] = [];
        const github = integrationGithub(writeInputs);
        let sandbox: MockSandboxClient | undefined;
        const executor = new CodingAgentExecutor({
            sandboxFactory: async scope => {
                sandbox = new MockSandboxClient({ workspace: await createSandboxWorkspace(scope) });
                return sandbox;
            },
            githubFactory: () => github,
            agentFactory: () => toolAgent(),
        });
        let id = 0;
        const object = new CodingSessionDurableObject(
            ctx,
            {} as CodingSessionDurableEnv,
            {
                executor,
                history: new CodingHistoryStore(new MemoryKV()),
                changes: new CodingChangeStore(new MemoryKV()),
                notifier,
                now: () => 1_000,
                idFactory: () => `id-${++id}`,
                configLoader: async () => undefined,
            } as CodingSessionDurableObjectOptions,
        );
        const coordinator = coordinatorFor(object);
        const reply = fakeReply();

        const code = new CodeCommandHandler({
            coordinator: () => coordinator,
            github,
            reply: () => reply.reply,
        });
        await code.handle(message({ text: '/code' }), '', context());
        expect(reply.keyboards[0].inline_keyboard[0][0].callback_data).toBe('code:repo:0');

        const callback = new CodingCallbackHandler({
            coordinator: () => coordinator,
            github,
            reply: () => reply.reply,
        });
        await callback.handle(callbackUpdate('code:repo:0'), context());
        await object.alarm();
        await ctx.drain();
        expect((await object.getState('10', '10'))?.status).toBe('awaiting_input');
        expect(sandbox?.commands.some(command => command.includes('git init -q'))).toBe(true);

        const messages = new CodingMessageHandler({ coordinator: () => coordinator, reply: () => reply.reply });
        await messages.handle(message({ text: 'Change the greeting and run tests' }), context());
        await object.alarm();
        await ctx.drain();

        const ready = await object.getState('10', '10');
        expect(ready?.approval?.status).toBe('pending');
        expect(writeInputs).toHaveLength(0);
        const approvalMessage = notifier.messages.find(item => item.keyboard);
        const keyboard = approvalMessage?.keyboard as { inline_keyboard: { callback_data: string }[][] } | undefined;
        const approveData = keyboard?.inline_keyboard
            .flat()
            .find(button => button.callback_data.includes(':approve:'))?.callback_data;
        expect(approveData).toBeTruthy();

        const approve = new CodingCallbackHandler({
            coordinator: () => coordinator,
            github,
            reply: () => reply.reply,
        });
        await approve.handle(callbackUpdate(approveData!), context());

        const completed = await object.getState('10', '10');
        expect(completed?.approval).toMatchObject({
            status: 'completed',
            branch: BRANCH,
            commitSha: COMMIT_SHA,
        });
        expect(writeInputs).toHaveLength(1);
        expect(writeInputs[0]).toMatchObject({
            baseRef: 'main',
            expectedBaseSha: BASE_SHA,
            branchName: expect.stringMatching(/^telegram-agent\//),
        });
        expect(writeInputs[0].changes[0]).toMatchObject({
            path: 'src/a.ts',
            status: 'modified',
        });
        expect(
            new TextDecoder().decode(
                Uint8Array.from(atob(writeInputs[0].changes[0].contentBase64!), c => c.charCodeAt(0)),
            ),
        ).toBe('new\n');
        expect(reply.texts.at(-1)).toContain('Approved changes were written to GitHub');
    });
});
