import type { ChatAgent, Message } from '@chatgpt-telegram-workers/agent';
import {
    CODING_TOOL_PERMISSION,
    createGitHubServiceFromEnv,
    loadChatLLM,
    registerCodingTools,
    registerGitHubTools,
    ToolRegistry,
    type GitHubService,
} from '@chatgpt-telegram-workers/agent';
import { ENV } from '@chatgpt-telegram-workers/config';
import {
    SandboxError,
    createDurableObjectSandboxClient,
    type SandboxClient,
    type SandboxNamespaceBinding,
    type SandboxScope,
} from '@chatgpt-telegram-workers/sandbox';
import { CodingSessionStore } from './session';
import { CodingSessionError, codingErrorMessage, type CodingRunResult, type CodingSessionState } from './types';

export interface CodingSessionManagerOptions {
    store: CodingSessionStore;
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

export class CodingSessionManager {
    private readonly store: CodingSessionStore;
    private readonly sandboxFactory: (scope: SandboxScope) => Promise<SandboxClient>;
    private readonly githubFactory: () => GitHubService;
    private readonly agentFactory: () => ChatAgent | null;
    private readonly maxSteps: number;
    private readonly timeoutMs: number;
    private readonly toolTimeoutMs: number;
    private readonly sandboxes = new Map<string, SandboxClient>();
    private readonly activeControllers = new Map<string, AbortController>();
    private readonly starting = new Set<string>();

    constructor(options: CodingSessionManagerOptions) {
        this.store = options.store;
        this.sandboxFactory =
            options.sandboxFactory ??
            (scope => createDurableObjectSandboxClient(ENV.SANDBOX as SandboxNamespaceBinding | null, scope));
        this.githubFactory = options.githubFactory ?? (() => createGitHubServiceFromEnv(ENV));
        this.agentFactory = options.agentFactory ?? (() => loadChatLLM(ENV.CONFIG));
        this.maxSteps = options.maxSteps ?? 12;
        this.timeoutMs = options.timeoutMs ?? 120_000;
        this.toolTimeoutMs = options.toolTimeoutMs ?? 60_000;
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
        let sandbox: SandboxClient | null = null;
        let phase: 'sandbox' | 'checkout' = 'sandbox';
        try {
            if (await this.store.get(userId, chatId)) {
                throw new CodingSessionError('active', 'A coding session is already active');
            }
            created = await this.store.create(userId, chatId, repository);
            if (!created) {
                throw new CodingSessionError('active', 'A coding session is already active');
            }

            sandbox = await this.ensureSandbox(created);
            await sandbox.list('');
            phase = 'checkout';
            const access = this.access(created);
            const github = this.githubFactory();
            const authorized = await github.listAuthorizedRepositories(access);
            if (!authorized.some(item => item.fullName.toLowerCase() === created!.repository)) {
                throw new CodingSessionError('unauthorized', 'Repository is not authorized for this user');
            }

            const checkout = await this.createRegistry(sandbox, github).execute(
                { id: 'bootstrap-checkout', name: 'repo_checkout', arguments: '{}' },
                access,
            );
            if (checkout.isError) {
                throw new CodingSessionError('checkout', checkout.content);
            }

            const ready = await this.store.update(created, { status: 'awaiting_input' });
            if (!ready) {
                throw new CodingSessionError('cancelled', 'Coding session was stopped');
            }
            return ready;
        } catch (error) {
            if (sandbox) {
                await sandbox.destroy().catch(() => undefined);
            }
            if (created) {
                this.sandboxes.delete(sessionMapKey(created));
                await this.store.delete(created).catch(() => undefined);
            }
            if (error instanceof CodingSessionError) {
                throw error;
            }
            if (error instanceof SandboxError || phase === 'sandbox') {
                throw new CodingSessionError('sandbox', codingErrorMessage(error), { cause: error });
            }
            throw new CodingSessionError('checkout', codingErrorMessage(error), { cause: error });
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
        if (this.activeControllers.has(key)) {
            throw new CodingSessionError('busy', 'The coding agent is already running');
        }
        const running = await this.store.update(current, { status: 'running' });
        if (!running) {
            throw new CodingSessionError('cancelled', 'Coding session was stopped');
        }

        const controller = new AbortController();
        this.activeControllers.set(key, controller);
        let phase: 'sandbox' | 'agent' = 'sandbox';
        try {
            const sandbox = await this.ensureSandbox(current);
            phase = 'agent';
            const agent = this.agentFactory();
            if (!agent) {
                throw new CodingSessionError('agent', 'No chat model is configured');
            }
            const history = await this.store.loadHistory(current);
            const userMessage: Message = { role: 'user', content: instruction };
            const result = await agent.completeWithTools([...history, userMessage], this.createRegistry(sandbox), {
                access: this.access(current),
                signal: controller.signal,
                maxSteps: this.maxSteps,
                timeoutMs: this.timeoutMs,
                toolTimeoutMs: this.toolTimeoutMs,
            });

            const ready = await this.store.update(current, { status: 'awaiting_input' });
            if (!ready) {
                throw new CodingSessionError('cancelled', 'Coding session was stopped');
            }
            await this.store.appendHistory(current, userMessage, { role: 'assistant', content: result.text });
            return { text: result.text, steps: result.steps, stopReason: result.stopReason };
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
            if (error instanceof SandboxError || phase === 'sandbox') {
                throw new CodingSessionError('sandbox', codingErrorMessage(error), { cause: error });
            }
            throw new CodingSessionError('agent', codingErrorMessage(error), { cause: error });
        } finally {
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
        const sandbox = this.sandboxes.get(key);
        this.sandboxes.delete(key);
        if (sandbox) {
            await sandbox.destroy().catch(() => undefined);
        }
        return session;
    }

    private access(session: CodingSessionState) {
        return {
            userId: session.userId,
            chatId: session.chatId,
            repository: session.repository,
            sessionId: session.sessionId,
            permissions: [CODING_TOOL_PERMISSION],
        };
    }

    private createRegistry(sandbox: SandboxClient, github = this.githubFactory()): ToolRegistry {
        const registry = new ToolRegistry();
        registerCodingTools(registry, { sandbox });
        registerGitHubTools(registry, { service: github, sandbox });
        return registry;
    }

    private async ensureSandbox(session: CodingSessionState): Promise<SandboxClient> {
        const key = sessionMapKey(session);
        const existing = this.sandboxes.get(key);
        if (existing) {
            return existing;
        }
        const sandbox = await this.sandboxFactory({
            userId: session.userId,
            repository: session.repository,
            sessionId: session.sessionId,
        });
        this.sandboxes.set(key, sandbox);
        return sandbox;
    }
}
