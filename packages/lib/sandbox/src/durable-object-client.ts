import { raceWithAbort } from './abort';
import type { SandboxDurableObjectStub, SandboxNamespaceBinding } from './durable-object';
import { SandboxAbortError, SandboxDisposedError, SandboxError } from './errors';
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

export type { SandboxDurableObjectStub, SandboxNamespaceBinding } from './durable-object';

/**
 * Adapts a SANDBOX Durable Object namespace to the provider-neutral
 * SandboxClient contract. The Durable Object owns the container; this client
 * only knows the workspace name and the restricted RPC surface.
 */
export class DurableObjectSandboxClient implements SandboxClient {
    private readonly scope: SandboxScope;
    private initialization: Promise<SandboxWorkspace> | null = null;
    private disposed = false;

    constructor(
        readonly workspace: SandboxWorkspace,
        scope: SandboxScope,
        private readonly stub: SandboxDurableObjectStub,
    ) {
        this.scope = {
            userId: workspace.userId,
            repository: workspace.repository,
            sessionId: workspace.sessionId,
        };
        if (
            scope.userId !== this.scope.userId ||
            scope.repository.toLowerCase() !== this.scope.repository ||
            (scope.sessionId ?? 'default') !== this.scope.sessionId
        ) {
            throw new SandboxError('invalid-workspace', 'Sandbox scope does not match the workspace');
        }
    }

    async exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
        const { signal, ...rest } = options;
        return this.call(signal, stub => stub.exec(command, rest));
    }

    async readFile(path: string, options: SandboxFileOptions = {}): Promise<Uint8Array> {
        const { signal, ...rest } = options;
        return this.call(signal, stub => stub.readFile(path, rest));
    }

    async writeFile(path: string, content: SandboxFileContent, options: SandboxFileOptions = {}): Promise<void> {
        const { signal, ...rest } = options;
        return this.call(signal, stub => stub.writeFile(path, content, rest));
    }

    async rename(from: string, to: string, options: SandboxFileOptions = {}): Promise<void> {
        const { signal, ...rest } = options;
        return this.call(signal, stub => stub.rename(from, to, rest));
    }

    async remove(path: string, options: SandboxRemoveOptions = {}): Promise<void> {
        const { signal, ...rest } = options;
        return this.call(signal, stub => stub.remove(path, rest));
    }

    async list(path = '', options: SandboxListOptions = {}): Promise<SandboxListResult> {
        const { signal, ...rest } = options;
        return this.call(signal, stub => stub.list(path, rest));
    }

    async snapshot(options: SandboxSnapshotOptions = {}): Promise<SandboxSnapshot> {
        const { signal, ...rest } = options;
        return this.call(signal, stub => stub.snapshot(rest));
    }

    async destroy(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.initialization = null;
        await this.stub.destroy();
    }

    private async call<T>(
        signal: AbortSignal | undefined,
        action: (stub: SandboxDurableObjectStub) => Promise<T>,
    ): Promise<T> {
        this.ensureAlive();
        if (signal?.aborted) {
            throw new SandboxAbortError('Sandbox operation aborted', { cause: signal.reason });
        }

        const effectiveSignal = signal ?? new AbortController().signal;
        const cancelRemote = () => {
            void Promise.resolve(this.stub.cancelAll()).catch(() => {
                // The operation may already have finished or the DO may be gone.
            });
        };
        signal?.addEventListener('abort', cancelRemote, { once: true });

        try {
            await this.ensureInitialized(effectiveSignal);
            return await raceWithAbort(action(this.stub), effectiveSignal);
        } catch (error) {
            if (signal?.aborted) {
                throw new SandboxAbortError('Sandbox operation aborted', { cause: error });
            }
            throw error;
        } finally {
            signal?.removeEventListener('abort', cancelRemote);
        }
    }

    private async ensureInitialized(signal: AbortSignal): Promise<void> {
        if (!this.initialization) {
            this.initialization = this.stub
                .initialize(this.scope)
                .then(workspace => {
                    if (workspace.id !== this.workspace.id) {
                        throw new SandboxError(
                            'invalid-workspace',
                            'Sandbox Durable Object returned a different workspace',
                        );
                    }
                    return workspace;
                })
                .catch(error => {
                    this.initialization = null;
                    throw error;
                });
        }
        await raceWithAbort(this.initialization, signal);
    }

    private ensureAlive(): void {
        if (this.disposed) {
            throw new SandboxDisposedError();
        }
    }
}

export async function createDurableObjectSandboxClient(
    namespace: SandboxNamespaceBinding | null | undefined,
    scope: SandboxScope,
): Promise<DurableObjectSandboxClient> {
    if (!namespace) {
        throw new SandboxError('unsupported', 'The SANDBOX Durable Object binding is not configured');
    }
    const workspace = await createSandboxWorkspace(scope);
    const stub = namespace.getByName(workspace.name);
    if (!stub) {
        throw new SandboxError('unsupported', `Sandbox Durable Object not found: ${workspace.name}`);
    }
    return new DurableObjectSandboxClient(workspace, scope, stub);
}
