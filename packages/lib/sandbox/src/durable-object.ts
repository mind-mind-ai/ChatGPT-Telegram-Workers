import {
    createCloudflareSandboxClient,
    type CloudflareContainer,
    type CloudflareSandboxClientOptions,
} from './cloudflare';
import { SandboxAbortError, SandboxDisposedError, SandboxError } from './errors';
import { DEFAULT_WORKSPACE_ROOT } from './limits';
import type {
    SandboxClient,
    SandboxExecOptions,
    SandboxExecResult,
    SandboxFileContent,
    SandboxFileOptions,
    SandboxListOptions,
    SandboxListResult,
    SandboxRemoveOptions,
    SandboxScope,
    SandboxSnapshot,
    SandboxSnapshotOptions,
    SandboxWorkspace,
} from './types';
import { createSandboxWorkspace } from './workspace';

const WORKSPACE_STORAGE_KEY = 'workspace';

/** The storage methods this Durable Object uses. */
export interface SandboxDurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
}

export interface SandboxDurableObjectId {
    readonly name?: string;
}

/** The subset of DurableObjectState used by the sandbox Durable Object. */
export interface SandboxDurableObjectState {
    readonly id?: SandboxDurableObjectId;
    readonly storage: SandboxDurableObjectStorage;
    readonly container?: CloudflareContainer;
}

export type SandboxDurableObjectEnv = Record<string, unknown>;

export type SandboxClientFactory = (
    state: SandboxDurableObjectState,
    options: Omit<CloudflareSandboxClientOptions, 'container'>,
) => SandboxClient;

export interface SandboxDurableObjectOptions {
    /** Injected in tests; production uses createCloudflareSandboxClient. */
    clientFactory?: SandboxClientFactory;
    rootDir?: string;
    instance?: CloudflareSandboxClientOptions['instance'];
    inactivityTimeoutMs?: number;
    shell?: string;
    execTimeoutMs?: number;
    maxOutputBytes?: number;
    maxFileBytes?: number;
    maxListEntries?: number;
}

export type SandboxDurableExecOptions = Omit<SandboxExecOptions, 'signal'>;
export type SandboxDurableFileOptions = Omit<SandboxFileOptions, 'signal'>;
export type SandboxDurableRemoveOptions = Omit<SandboxRemoveOptions, 'signal'>;
export type SandboxDurableListOptions = Omit<SandboxListOptions, 'signal'>;
export type SandboxDurableSnapshotOptions = Omit<SandboxSnapshotOptions, 'signal'>;

export interface SandboxDurableStatus {
    workspace: SandboxWorkspace | null;
    hasClient: boolean;
    activeOperations: number;
}

/** The RPC surface exposed by a sandbox Durable Object stub. */
export interface SandboxDurableObjectStub {
    initialize(scope: SandboxScope): Promise<SandboxWorkspace>;
    getStatus(): Promise<SandboxDurableStatus>;
    exec(command: string, options?: SandboxDurableExecOptions): Promise<SandboxExecResult>;
    readFile(path: string, options?: SandboxDurableFileOptions): Promise<Uint8Array>;
    writeFile(path: string, content: SandboxFileContent, options?: SandboxDurableFileOptions): Promise<void>;
    rename(from: string, to: string, options?: SandboxDurableFileOptions): Promise<void>;
    remove(path: string, options?: SandboxDurableRemoveOptions): Promise<void>;
    list(path?: string, options?: SandboxDurableListOptions): Promise<SandboxListResult>;
    snapshot(options?: SandboxDurableSnapshotOptions): Promise<SandboxSnapshot>;
    destroy(): Promise<void>;
    cancelAll(): Promise<number>;
}

/** The subset of a Durable Object namespace binding used by the sandbox adapter. */
export interface SandboxNamespaceBinding {
    getByName(name: string): SandboxDurableObjectStub;
}

function defaultClientFactory(
    state: SandboxDurableObjectState,
    options: Omit<CloudflareSandboxClientOptions, 'container'>,
): SandboxClient {
    return createCloudflareSandboxClient(state, options);
}

/**
 * One Durable Object per user/repository/session workspace.
 *
 * The object owns the container lifecycle and exposes only typed sandbox
 * operations. It never exposes the container itself, and it never receives
 * Telegram, GitHub, or LLM credentials.
 */
export class SandboxDurableObject {
    private readonly clientFactory: SandboxClientFactory;
    private readonly rootDir: string;
    private readonly options: SandboxDurableObjectOptions;
    private workspace: SandboxWorkspace | null = null;
    private client: SandboxClient | null = null;
    private initialization: Promise<SandboxWorkspace> | null = null;
    private initializationId: string | null = null;
    private destroyed = false;
    private readonly activeControllers = new Set<AbortController>();

    constructor(
        private readonly ctx: SandboxDurableObjectState,
        private readonly _env: SandboxDurableObjectEnv = {},
        options: SandboxDurableObjectOptions = {},
    ) {
        this.clientFactory = options.clientFactory ?? defaultClientFactory;
        this.rootDir = options.rootDir ?? DEFAULT_WORKSPACE_ROOT;
        this.options = options;
    }

    /**
     * Binds this object to a workspace. Repeating the same scope is idempotent;
     * a different user, repository, or session is rejected.
     */
    async initialize(scope: SandboxScope): Promise<SandboxWorkspace> {
        const requested = await createSandboxWorkspace(scope, this.rootDir);
        if (this.ctx.id?.name && this.ctx.id.name !== requested.name) {
            throw new SandboxError(
                'invalid-workspace',
                'Durable Object name does not match the requested sandbox workspace',
            );
        }
        if (this.workspace && this.workspace.id !== requested.id) {
            throw new SandboxError('invalid-workspace', 'This Durable Object belongs to a different workspace');
        }
        if (this.initialization) {
            if (this.initializationId !== requested.id) {
                throw new SandboxError('invalid-workspace', 'This Durable Object belongs to a different workspace');
            }
            return this.initialization;
        }
        this.initializationId = requested.id;
        this.initialization = this.initializeInternal(requested).catch(error => {
            this.initialization = null;
            this.initializationId = null;
            throw error;
        });
        return this.initialization;
    }

    async getStatus(): Promise<SandboxDurableStatus> {
        if (this.destroyed) {
            return { workspace: null, hasClient: false, activeOperations: 0 };
        }
        await this.loadWorkspace();
        return {
            workspace: this.workspace,
            hasClient: this.client !== null,
            activeOperations: this.activeControllers.size,
        };
    }

    async exec(command: string, options: SandboxDurableExecOptions = {}): Promise<SandboxExecResult> {
        const client = await this.requireClient();
        return this.run('exec', signal => client.exec(command, { ...options, signal }));
    }

    async readFile(path: string, options: SandboxDurableFileOptions = {}): Promise<Uint8Array> {
        const client = await this.requireClient();
        return this.run('readFile', signal => client.readFile(path, { ...options, signal }));
    }

    async writeFile(path: string, content: SandboxFileContent, options: SandboxDurableFileOptions = {}): Promise<void> {
        const client = await this.requireClient();
        return this.run('writeFile', signal => client.writeFile(path, content, { ...options, signal }));
    }

    async rename(from: string, to: string, options: SandboxDurableFileOptions = {}): Promise<void> {
        const client = await this.requireClient();
        return this.run('rename', signal => client.rename(from, to, { ...options, signal }));
    }

    async remove(path: string, options: SandboxDurableRemoveOptions = {}): Promise<void> {
        const client = await this.requireClient();
        return this.run('remove', signal => client.remove(path, { ...options, signal }));
    }

    async list(path = '', options: SandboxDurableListOptions = {}): Promise<SandboxListResult> {
        const client = await this.requireClient();
        return this.run('list', signal => client.list(path, { ...options, signal }));
    }

    async snapshot(options: SandboxDurableSnapshotOptions = {}): Promise<SandboxSnapshot> {
        const client = await this.requireClient();
        return this.run('snapshot', signal => client.snapshot({ ...options, signal }));
    }

    /** Aborts all in-flight operations and destroys the container. */
    async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.cancelAll();
        const client = this.client ?? (this.workspace ? this.createClient(this.workspace) : null);
        this.client = null;
        this.workspace = null;
        this.initialization = null;
        this.initializationId = null;
        this.destroyed = true;
        await this.ctx.storage.delete(WORKSPACE_STORAGE_KEY);

        if (client) {
            await client.destroy();
            return;
        }
        if (this.ctx.container?.running) {
            await this.ctx.container.destroy();
        }
    }

    /** Cancels in-flight operations; returns the number of aborted operations. */
    cancelAll(): number {
        let cancelled = 0;
        for (const controller of this.activeControllers) {
            if (!controller.signal.aborted) {
                controller.abort(new SandboxAbortError('Sandbox operation cancelled'));
                cancelled++;
            }
        }
        return cancelled;
    }

    private async initializeInternal(workspace: SandboxWorkspace): Promise<SandboxWorkspace> {
        const stored = await this.ctx.storage.get<SandboxWorkspace>(WORKSPACE_STORAGE_KEY);
        if (stored && stored.id !== workspace.id) {
            throw new SandboxError('invalid-workspace', 'This Durable Object belongs to a different workspace');
        }
        const resolved = stored ?? workspace;
        this.workspace = resolved;
        this.destroyed = false;
        if (!stored) {
            await this.ctx.storage.put(WORKSPACE_STORAGE_KEY, resolved);
        }
        return resolved;
    }

    private async loadWorkspace(): Promise<SandboxWorkspace | null> {
        if (this.workspace) {
            return this.workspace;
        }
        this.workspace = (await this.ctx.storage.get<SandboxWorkspace>(WORKSPACE_STORAGE_KEY)) ?? null;
        return this.workspace;
    }

    private async requireClient(): Promise<SandboxClient> {
        if (this.destroyed) {
            throw new SandboxDisposedError();
        }
        const workspace = await this.loadWorkspace();
        if (!workspace) {
            throw new SandboxError('not-initialized', 'Sandbox Durable Object has not been initialized');
        }
        if (!this.client) {
            this.client = this.createClient(workspace);
        }
        return this.client;
    }

    private createClient(workspace: SandboxWorkspace): SandboxClient {
        try {
            return this.clientFactory(this.ctx, {
                workspace,
                instance: this.options.instance ?? 'basic',
                inactivityTimeoutMs: this.options.inactivityTimeoutMs,
                shell: this.options.shell,
                execTimeoutMs: this.options.execTimeoutMs,
                maxOutputBytes: this.options.maxOutputBytes,
                maxFileBytes: this.options.maxFileBytes,
                maxListEntries: this.options.maxListEntries,
            });
        } catch (error) {
            if (error instanceof SandboxError) {
                throw error;
            }
            throw new SandboxError('internal', 'Failed to create the sandbox client', { cause: error });
        }
    }

    private async run<T>(operation: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        this.activeControllers.add(controller);
        try {
            return await action(controller.signal);
        } catch (error) {
            if (error instanceof SandboxError) {
                throw error;
            }
            throw new SandboxError('internal', `Sandbox operation failed: ${operation}`, { cause: error });
        } finally {
            this.activeControllers.delete(controller);
        }
    }
}
