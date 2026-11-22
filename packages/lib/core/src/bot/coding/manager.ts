import type { ChatAgent } from '@chatgpt-telegram-workers/agent';
import { createGitHubServiceFromEnv, loadChatLLM, type GitHubService } from '@chatgpt-telegram-workers/agent';
import { ENV } from '@chatgpt-telegram-workers/config';
import {
    createDurableObjectSandboxClient,
    type SandboxClient,
    type SandboxNamespaceBinding,
    type SandboxScope,
} from '@chatgpt-telegram-workers/sandbox';
import { CodingAgentExecutor } from './executor';
import { CodingSessionStore } from './session';
import { CodingSessionError, codingErrorMessage, type CodingRunResult, type CodingSessionState } from './types';

export interface CodingSessionManagerOptions {
    store: CodingSessionStore;
    executor?: CodingAgentExecutor;
    sandboxFactory?: (scope: SandboxScope) => Promise<SandboxClient>;
    githubFactory?: () => GitHubService;
    agentFactory?: () => ChatAgent | null;
    maxSteps?: number;
    timeoutMs?: number;
    toolTimeoutMs?: number;
}

function sessionMapKey(session: Pick<CodingSessionState, 'userId' | 'chatId' | 'sessionId'>): string {
    return `${session.chatId}:${session.userId}:${session.sessionId}`;
}

/**
 * Compatibility manager for the synchronous coding path. Telegram production
 * traffic uses CodingSessionDurableObject; this class keeps the lower-level
 * session/history semantics testable and available to other callers.
 */
export class CodingSessionManager {
    private readonly store: CodingSessionStore;
    private readonly executor: CodingAgentExecutor;
    private readonly activeControllers = new Map<string, AbortController>();
    private readonly activeInstructions = new Set<string>();
    private readonly starting = new Set<string>();

    constructor(options: CodingSessionManagerOptions) {
        this.store = options.store;
        this.executor =
            options.executor ??
            new CodingAgentExecutor({
                sandboxFactory:
                    options.sandboxFactory ??
                    (scope => createDurableObjectSandboxClient(ENV.SANDBOX as SandboxNamespaceBinding | null, scope)),
                githubFactory: options.githubFactory ?? (() => createGitHubServiceFromEnv(ENV)),
                agentFactory: options.agentFactory ?? (() => loadChatLLM(ENV.CONFIG)),
                maxSteps: options.maxSteps,
                timeoutMs: options.timeoutMs,
                toolTimeoutMs: options.toolTimeoutMs,
            });
    }

    async getSession(userId: string, chatId: string): Promise<CodingSessionState | null> {
        return this.store.get(userId, chatId);
    }

    statusLabel(session: CodingSessionState): string {
        return this.store.statusLabel(session.status);
    }

    async startSession(userId: string, chatId: string, repository: string): Promise<CodingSessionState> {
        const key = `${chatId}:${userId}`;
        if (this.starting.has(key)) {
            throw new CodingSessionError('active', 'A coding session is already starting');
        }
        this.starting.add(key);
        let created: CodingSessionState | null = null;
        try {
            if (await this.store.get(userId, chatId)) {
                throw new CodingSessionError('active', 'A coding session is already active');
            }
            created = await this.store.create(userId, chatId, repository);
            if (!created) {
                throw new CodingSessionError('active', 'A coding session is already active');
            }

            await this.executor.prepare(created);
            const ready = await this.store.update(created, { status: 'awaiting_input' });
            if (!ready) {
                throw new CodingSessionError('cancelled', 'Coding session was stopped');
            }
            return ready;
        } catch (error) {
            if (created) {
                await this.executor.destroy(created).catch(() => undefined);
                await this.store.delete(created).catch(() => undefined);
            }
            if (error instanceof CodingSessionError) {
                throw error;
            }
            throw new CodingSessionError('sandbox', codingErrorMessage(error), { cause: error });
        } finally {
            this.starting.delete(key);
        }
    }

    async runInstruction(session: CodingSessionState, instruction: string): Promise<CodingRunResult> {
        const current = await this.store.get(session.userId, session.chatId);
        if (!current || current.sessionId !== session.sessionId) {
            throw new CodingSessionError('expired', 'Coding session is no longer active');
        }
        if (current.status === 'running') {
            throw new CodingSessionError('busy', 'The coding agent is already running');
        }
        if (current.status === 'initializing') {
            throw new CodingSessionError('busy', 'The coding session is still starting');
        }

        const key = sessionMapKey(current);
        if (this.activeControllers.has(key) || this.activeInstructions.has(key)) {
            throw new CodingSessionError('busy', 'The coding agent is already running');
        }
        this.activeInstructions.add(key);
        const running = await this.store.update(current, { status: 'running' });
        if (!running) {
            throw new CodingSessionError('cancelled', 'Coding session was stopped');
        }

        const controller = new AbortController();
        this.activeControllers.set(key, controller);
        try {
            const history = await this.store.loadHistory(current);
            const result = await this.executor.run(current, instruction, history, controller.signal);
            const ready = await this.store.update(current, { status: 'awaiting_input' });
            if (!ready) {
                throw new CodingSessionError('cancelled', 'Coding session was stopped');
            }
            await this.store.appendHistory(
                current,
                { role: 'user', content: instruction },
                {
                    role: 'assistant',
                    content: result.text,
                },
            );
            return result;
        } catch (error) {
            if (controller.signal.aborted) {
                throw new CodingSessionError('cancelled', 'Coding operation cancelled');
            }
            const existing = await this.store.get(current.userId, current.chatId);
            if (!existing || existing.sessionId !== current.sessionId) {
                throw new CodingSessionError('cancelled', 'Coding session was stopped');
            }
            await this.store.update(existing, { status: 'awaiting_input' }).catch(() => undefined);
            if (error instanceof CodingSessionError) {
                throw error;
            }
            throw new CodingSessionError('agent', codingErrorMessage(error), { cause: error });
        } finally {
            this.activeInstructions.delete(key);
            this.activeControllers.delete(key);
        }
    }

    async stopSession(userId: string, chatId: string): Promise<CodingSessionState | null> {
        const session = await this.store.get(userId, chatId);
        if (!session) {
            return null;
        }
        const key = sessionMapKey(session);
        this.activeControllers.get(key)?.abort(new CodingSessionError('cancelled', 'Coding session stopped'));
        this.activeControllers.delete(key);
        await this.store.delete(session);
        await this.executor.destroy(session);
        return session;
    }
}
