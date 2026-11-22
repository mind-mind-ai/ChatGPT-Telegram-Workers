import type { ChatAgent, GitHubService, Message } from '@chatgpt-telegram-workers/agent';
import type { KVNamespaceBinding } from '@chatgpt-telegram-workers/config';
import {
    MockSandboxClient,
    createSandboxWorkspace,
    type SandboxClient,
    type SandboxScope,
} from '@chatgpt-telegram-workers/sandbox';
import type * as Telegram from 'telegram-bot-api-types';
import type { WorkerContext } from '../context';
import type { CodingReply } from './telegram';
import type { CodingDurableSession, CodingJobState, CodingSessionCoordinator, CodingSessionState } from './types';

export class MemoryKV implements KVNamespaceBinding {
    readonly values = new Map<string, string>();
    readonly ttl = new Map<string, number>();

    async get(key: string): Promise<string | null> {
        return this.values.get(key) ?? null;
    }

    async put(key: string, value: string, info?: { expirationTtl?: number }): Promise<void> {
        this.values.set(key, value);
        if (info?.expirationTtl) {
            this.ttl.set(key, info.expirationTtl);
        }
    }

    async delete(key: string): Promise<void> {
        this.values.delete(key);
        this.ttl.delete(key);
    }
}

export function message(overrides: Partial<Telegram.Message> = {}): Telegram.Message {
    return {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: 10, type: 'private' },
        from: { id: 10, is_bot: false, first_name: 'User' },
        text: 'hello',
        ...overrides,
    } as Telegram.Message;
}

export function context(): WorkerContext {
    return {
        SHARE_CONTEXT: {
            botToken: '123:test',
            botId: 123,
            chatHistoryKey: 'history:10',
            lastMessageKey: 'last:10',
        },
    } as unknown as WorkerContext;
}

export function fakeReply() {
    const texts: string[] = [];
    const keyboards: Telegram.InlineKeyboardMarkup[] = [];
    const documents: { filename: string; content: Uint8Array; caption?: string }[] = [];
    const answers: string[] = [];
    const reply: CodingReply = {
        sendText: async text => {
            texts.push(text);
            return new Response('OK', { status: 200 });
        },
        sendKeyboard: async (text, keyboard) => {
            texts.push(text);
            keyboards.push(keyboard);
            return new Response('OK', { status: 200 });
        },
        sendDocument: async (filename, content, caption) => {
            documents.push({ filename, content, ...(caption ? { caption } : {}) });
            return new Response('OK', { status: 200 });
        },
        answerCallback: async text => {
            answers.push(text ?? '');
        },
    };
    return { reply, texts, keyboards, documents, answers };
}

export async function sandboxFor(scope: SandboxScope): Promise<MockSandboxClient> {
    const workspace = await createSandboxWorkspace(scope);
    return new MockSandboxClient({ workspace });
}

export function fakeGithub(
    options: {
        repositories?: string[];
        checkoutError?: Error;
        onCheckout?: (repository: string, sandbox: SandboxClient) => void;
    } = {},
): GitHubService {
    const repositories = (options.repositories ?? ['octo/repo']).map(fullName => {
        const [owner, name] = fullName.split('/');
        return { owner, name, fullName };
    });
    return {
        listAuthorizedRepositories: async () => repositories,
        checkoutRepository: async (repository: string, _context: unknown, sandbox: SandboxClient) => {
            if (options.checkoutError) {
                throw options.checkoutError;
            }
            options.onCheckout?.(repository, sandbox);
            const [owner, name] = repository.split('/');
            return {
                repository: { owner, name, fullName: repository },
                ref: 'main',
                commitSha: 'a'.repeat(40),
                filesWritten: 1,
                bytesWritten: 5,
                skippedFiles: 0,
            };
        },
        getBranchHead: async () => ({ ref: 'refs/heads/main', sha: 'a'.repeat(40) }),
        writeChanges: async () => ({
            repository: { owner: 'octo', name: 'repo', fullName: 'octo/repo' },
            baseRef: 'main',
            baseSha: 'a'.repeat(40),
            branch: 'telegram-agent/test',
            commitSha: 'b'.repeat(40),
            filesChanged: 1,
        }),
    } as unknown as GitHubService;
}

export function fakeAgent(result = 'done'): ChatAgent {
    return {
        name: 'fake',
        label: 'Fake',
        model: 'fake',
        modelList: async () => ['fake'],
        chat: async () => result,
        completeWithTools: async () => ({
            text: result,
            messages: [],
            steps: 1,
            toolCalls: [],
            toolResults: [],
            stopReason: 'complete',
        }),
    };
}

export function session(overrides: Partial<CodingSessionState> = {}): CodingSessionState {
    return {
        version: 1,
        sessionId: 'session-1',
        userId: '10',
        chatId: '10',
        repository: 'octo/repo',
        status: 'awaiting_input',
        createdAt: 0,
        updatedAt: 0,
        expiresAt: Date.now() + 60_000,
        ...overrides,
    };
}

export function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

export function textMessage(text: string, overrides: Partial<Telegram.Message> = {}): Telegram.Message {
    return message({ text, ...overrides });
}

export function assistantMessage(text: string): Message {
    return { role: 'assistant', content: text };
}

export function durableJob(overrides: Partial<CodingJobState> = {}): CodingJobState {
    return {
        id: 'job-1',
        kind: 'checkout',
        status: 'completed',
        createdAt: 0,
        finishedAt: 1,
        progress: 'Completed',
        ...overrides,
    };
}

export function durableSession(overrides: Partial<CodingDurableSession> = {}): CodingDurableSession {
    return {
        version: 2,
        sessionId: 'session-1',
        userId: '10',
        chatId: '10',
        repository: 'octo/repo',
        status: 'awaiting_input',
        cancellationRequested: false,
        createdAt: 0,
        updatedAt: 0,
        expiresAt: Date.now() + 60_000,
        job: durableJob(),
        ...overrides,
    };
}

export function fakeCoordinator(overrides: Partial<CodingSessionCoordinator> = {}): CodingSessionCoordinator {
    return {
        getState: async () => null,
        createSession: async () =>
            durableSession({
                status: 'queued',
                job: durableJob({ kind: 'checkout', status: 'queued', progress: 'Preparing repository...' }),
            }),
        enqueueInstruction: async () =>
            durableSession({
                status: 'queued',
                job: durableJob({ kind: 'instruction', status: 'queued', instruction: 'work' }),
            }),
        stopSession: async () => durableSession({ status: 'cancelled', cancellationRequested: true }),
        reviewApproval: async () => {
            throw new Error('No approval in fake coordinator');
        },
        approveChanges: async () => {
            throw new Error('No approval in fake coordinator');
        },
        rejectChanges: async () => {
            throw new Error('No approval in fake coordinator');
        },
        ...overrides,
    };
}

export function coordinatorFactory(coordinator: CodingSessionCoordinator) {
    return () => coordinator;
}
