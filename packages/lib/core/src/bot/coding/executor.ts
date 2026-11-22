import type { ChatAgent, Message } from '@chatgpt-telegram-workers/agent';
import {
    CODING_TOOL_PERMISSION,
    registerCodingTools,
    registerGitHubTools,
    ToolRegistry,
    type GitHubCheckoutResult,
    type GitHubService,
    type GitHubWriteChangesInput,
    type GitHubWriteChangesResult,
} from '@chatgpt-telegram-workers/agent';
import { SandboxError, type SandboxClient, type SandboxScope } from '@chatgpt-telegram-workers/sandbox';
import { collectCodingChanges } from './changes';
import { CODING_SYSTEM_PROMPT } from './prompt';
import { CodingSessionError, codingErrorMessage, type CodingChangeSet, type CodingRunResult } from './types';

export interface CodingWorkspaceSession {
    userId: string;
    chatId: string;
    repository: string;
    sessionId: string;
}

export type CodingProgressHandler = (message: string) => void | Promise<void>;

export interface CodingAgentExecutorOptions {
    sandboxFactory: (scope: SandboxScope) => Promise<SandboxClient>;
    githubFactory: () => GitHubService;
    agentFactory: () => ChatAgent | null;
    maxSteps?: number;
    timeoutMs?: number;
    toolTimeoutMs?: number;
    systemPrompt?: string;
}

/**
 * Runs coding work against one sandbox. Session ownership, status and job
 * scheduling belong to CodingSessionDurableObject; this class only performs
 * the sandbox/GitHub/agent operations.
 */
export class CodingAgentExecutor {
    private readonly sandboxes = new Map<string, SandboxClient>();
    private readonly systemPrompt: string;

    constructor(private readonly options: CodingAgentExecutorOptions) {
        this.systemPrompt = options.systemPrompt ?? CODING_SYSTEM_PROMPT;
    }

    async prepare(
        session: CodingWorkspaceSession,
        signal?: AbortSignal,
        onProgress?: CodingProgressHandler,
    ): Promise<GitHubCheckoutResult> {
        let sandbox: SandboxClient;
        try {
            sandbox = await this.ensureSandbox(session);
            await sandbox.list('', { signal });
        } catch (error) {
            throw this.asCodingError(error, 'sandbox', 'Sandbox initialization failed');
        }

        await onProgress?.('Inspecting the authorized repository...');
        const access = this.access(session);
        try {
            const github = this.options.githubFactory();
            const authorized = await github.listAuthorizedRepositories(access);
            if (!authorized.some(item => item.fullName.toLowerCase() === session.repository.toLowerCase())) {
                throw new CodingSessionError('unauthorized', 'Repository is not authorized for this user');
            }

            await onProgress?.('Checking out the repository into the sandbox...');
            const result = await github.checkoutRepository(session.repository, access, sandbox, { signal });
            let commitSha = result.commitSha;
            if (!commitSha && github.getBranchHead) {
                const head = await github.getBranchHead(session.repository, access, result.ref, { signal });
                commitSha = head.sha;
            }
            return { ...result, ...(commitSha ? { commitSha } : {}) };
        } catch (error) {
            throw this.asCodingError(error, 'checkout', 'Repository checkout failed');
        }
    }

    async collectChanges(
        session: CodingWorkspaceSession,
        baseRef: string,
        baseCommitSha: string,
        signal?: AbortSignal,
    ): Promise<CodingChangeSet | null> {
        let sandbox: SandboxClient;
        try {
            sandbox = await this.ensureSandbox(session);
            return await collectCodingChanges({
                session,
                baseRef,
                baseCommitSha,
                github: this.options.githubFactory(),
                sandbox,
                signal,
            });
        } catch (error) {
            if (error instanceof CodingSessionError) {
                throw error;
            }
            throw this.asCodingError(error, 'sandbox', 'Change review failed');
        }
    }

    async writeApprovedChanges(
        session: CodingWorkspaceSession,
        input: GitHubWriteChangesInput,
        signal?: AbortSignal,
    ): Promise<GitHubWriteChangesResult> {
        return this.options.githubFactory().writeChanges(session.repository, this.access(session), input, {
            signal,
        });
    }

    async run(
        session: CodingWorkspaceSession,
        instruction: string,
        history: Message[],
        signal?: AbortSignal,
        onProgress?: CodingProgressHandler,
    ): Promise<CodingRunResult> {
        let sandbox: SandboxClient;
        try {
            sandbox = await this.ensureSandbox(session);
        } catch (error) {
            throw this.asCodingError(error, 'sandbox', 'Sandbox initialization failed');
        }

        const agent = this.options.agentFactory();
        if (!agent) {
            throw new CodingSessionError('agent', 'No chat model is configured');
        }

        await onProgress?.('Running the coding agent...');
        const userMessage: Message = { role: 'user', content: instruction };
        try {
            const result = await agent.completeWithTools([...history, userMessage], this.createRegistry(sandbox), {
                access: this.access(session),
                signal,
                maxSteps: this.options.maxSteps ?? 12,
                timeoutMs: this.options.timeoutMs ?? 120_000,
                toolTimeoutMs: this.options.toolTimeoutMs ?? 60_000,
                system: this.systemPrompt,
            });
            return { text: result.text, steps: result.steps, stopReason: result.stopReason };
        } catch (error) {
            throw this.asCodingError(error, 'agent', 'Coding agent failed');
        }
    }

    async destroy(session: CodingWorkspaceSession): Promise<void> {
        const key = this.sandboxKey(session);
        const sandbox = this.sandboxes.get(key);
        this.sandboxes.delete(key);
        if (sandbox) {
            await sandbox.destroy().catch(() => undefined);
        }
    }

    private access(session: CodingWorkspaceSession) {
        return {
            userId: session.userId,
            chatId: session.chatId,
            repository: session.repository,
            sessionId: session.sessionId,
            permissions: [CODING_TOOL_PERMISSION],
        };
    }

    private createRegistry(sandbox: SandboxClient, github = this.options.githubFactory()): ToolRegistry {
        const registry = new ToolRegistry();
        registerCodingTools(registry, { sandbox });
        registerGitHubTools(registry, { service: github, sandbox });
        return registry;
    }

    private async ensureSandbox(session: CodingWorkspaceSession): Promise<SandboxClient> {
        const key = this.sandboxKey(session);
        const existing = this.sandboxes.get(key);
        if (existing) {
            return existing;
        }
        const sandbox = await this.options.sandboxFactory({
            userId: session.userId,
            repository: session.repository,
            sessionId: session.sessionId,
        });
        this.sandboxes.set(key, sandbox);
        return sandbox;
    }

    private sandboxKey(session: CodingWorkspaceSession): string {
        return `${session.chatId}:${session.userId}:${session.sessionId}`;
    }

    private asCodingError(error: unknown, fallback: 'sandbox' | 'checkout' | 'agent', message: string): Error {
        if (error instanceof CodingSessionError) {
            return error;
        }
        if (error instanceof SandboxError) {
            return new CodingSessionError('sandbox', codingErrorMessage(error), { cause: error });
        }
        return new CodingSessionError(fallback, `${message}: ${codingErrorMessage(error)}`, { cause: error });
    }
}
