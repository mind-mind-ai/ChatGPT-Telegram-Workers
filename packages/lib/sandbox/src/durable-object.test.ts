import { describe, expect, it } from 'vitest';
import {
    type CloudflareContainer,
    type CloudflareContainerStartOptions,
    type CloudflareExecProcess,
} from './cloudflare';
import {
    SandboxDurableObject,
    type SandboxClientFactory,
    type SandboxDurableObjectState,
    type SandboxDurableObjectStorage,
} from './durable-object';
import { SandboxAbortError, SandboxDisposedError, SandboxTimeoutError } from './errors';
import { MockSandboxClient } from './mock';
import type {
    SandboxClient,
    SandboxExecOptions,
    SandboxExecResult,
    SandboxFileContent,
    SandboxFileOptions,
    SandboxListOptions,
    SandboxListResult,
    SandboxRemoveOptions,
    SandboxSnapshot,
    SandboxSnapshotOptions,
    SandboxWorkspace,
} from './types';
import { createSandboxWorkspace } from './workspace';

class FakeStorage implements SandboxDurableObjectStorage {
    readonly values = new Map<string, unknown>();

    async get<T = unknown>(key: string): Promise<T | undefined> {
        return this.values.get(key) as T | undefined;
    }

    async put<T = unknown>(key: string, value: T): Promise<void> {
        this.values.set(key, value);
    }

    async delete(key: string): Promise<boolean> {
        return this.values.delete(key);
    }
}

function createState(name?: string, container?: CloudflareContainer): SandboxDurableObjectState {
    return {
        ...(name ? { id: { name } } : {}),
        storage: new FakeStorage(),
        ...(container ? { container } : {}),
    };
}

function streamOf(value: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            if (value) {
                controller.enqueue(new TextEncoder().encode(value));
            }
            controller.close();
        },
    });
}

class FakeProcess implements CloudflareExecProcess {
    readonly stdout = streamOf('hello');
    readonly stderr = streamOf('');
    readonly exitCode = Promise.resolve(0);
    killed = false;

    kill(): void {
        this.killed = true;
    }
}

class FakeContainer implements CloudflareContainer {
    readonly images = { sandbox: 'registry.example/sandbox:1.0.3' };
    running = false;
    destroyed = false;
    startOptions: CloudflareContainerStartOptions | undefined;
    execCalls: string[][] = [];

    start(options: CloudflareContainerStartOptions): void {
        this.startOptions = options;
        this.running = true;
    }

    async destroy(): Promise<void> {
        this.running = false;
        this.destroyed = true;
    }

    async setInactivityTimeout(_durationMs: number | bigint): Promise<void> {}

    async snapshotContainer(options?: { name?: string }): Promise<{ id: string; size: number; name?: string }> {
        return { id: 'snapshot-1', size: 1, name: options?.name };
    }

    async exec(cmd: string[]): Promise<CloudflareExecProcess> {
        this.execCalls.push(cmd);
        return new FakeProcess();
    }
}

class FakeClient implements SandboxClient {
    readonly calls: string[] = [];
    destroyed = false;
    execHandler: (command: string, options?: SandboxExecOptions) => Promise<SandboxExecResult>;

    constructor(readonly workspace: SandboxWorkspace) {
        this.execHandler = async (command, options) => ({
            command,
            cwd: options?.cwd ?? workspace.rootDir,
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            truncated: false,
            durationMs: 1,
        });
    }

    async exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
        this.calls.push(`exec:${command}`);
        return this.execHandler(command, options);
    }

    async readFile(path: string, _options?: SandboxFileOptions): Promise<Uint8Array> {
        this.calls.push(`read:${path}`);
        return new TextEncoder().encode(`read:${path}`);
    }

    async writeFile(path: string, content: SandboxFileContent, _options?: SandboxFileOptions): Promise<void> {
        this.calls.push(`write:${path}:${String(content)}`);
    }

    async rename(from: string, to: string, _options?: SandboxFileOptions): Promise<void> {
        this.calls.push(`rename:${from}:${to}`);
    }

    async remove(path: string, _options?: SandboxRemoveOptions): Promise<void> {
        this.calls.push(`remove:${path}`);
    }

    async list(path = '', _options?: SandboxListOptions): Promise<SandboxListResult> {
        this.calls.push(`list:${path}`);
        return { path, entries: [], truncated: false };
    }

    async snapshot(_options?: SandboxSnapshotOptions): Promise<SandboxSnapshot> {
        this.calls.push('snapshot');
        return { id: 'snapshot-1', size: 1, createdAt: 1 };
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
    }
}

async function createFixture(scope = { userId: 'alice', repository: 'owner/repo', sessionId: 's1' }): Promise<{
    object: SandboxDurableObject;
    workspace: SandboxWorkspace;
    state: SandboxDurableObjectState;
    clients: FakeClient[];
    options: Parameters<SandboxClientFactory>[1][];
}> {
    const workspace = await createSandboxWorkspace(scope);
    const state = createState(workspace.name);
    const clients: FakeClient[] = [];
    const options: Parameters<SandboxClientFactory>[1][] = [];
    const factory: SandboxClientFactory = (_state, clientOptions) => {
        options.push(clientOptions);
        const client = new FakeClient(clientOptions.workspace);
        clients.push(client);
        return client;
    };
    return {
        object: new SandboxDurableObject(state, {}, { clientFactory: factory }),
        workspace,
        state,
        clients,
        options,
    };
}

describe('SandboxDurableObject', () => {
    it('initializes one workspace and delegates sandbox operations to its client', async () => {
        const { object, workspace, options } = await createFixture();
        expect(await object.initialize({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' })).toEqual(
            workspace,
        );
        expect(options).toHaveLength(0);

        const result = await object.exec('npm test', { cwd: 'src', timeoutMs: 1_000 });
        expect(result).toMatchObject({ command: 'npm test', cwd: 'src', exitCode: 0 });
        await object.writeFile('src/a.ts', 'hello');
        expect(new TextDecoder().decode(await object.readFile('src/a.ts'))).toBe('read:src/a.ts');
        await object.rename('src/a.ts', 'src/b.ts');
        await object.remove('src/b.ts');
        expect(await object.list('src')).toEqual({ path: 'src', entries: [], truncated: false });
        expect(await object.snapshot({ name: 'checkpoint' })).toMatchObject({ id: 'snapshot-1' });

        expect(options[0]).toMatchObject({
            workspace,
            instance: 'basic',
        });
        expect(await object.getStatus()).toMatchObject({
            workspace,
            hasClient: true,
            activeOperations: 0,
        });
    });

    it('rejects a different workspace and a mismatched Durable Object name', async () => {
        const { object, state } = await createFixture();
        await object.initialize({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' });

        await expect(
            object.initialize({ userId: 'bob', repository: 'owner/repo', sessionId: 's1' }),
        ).rejects.toMatchObject({ code: 'invalid-workspace' });

        const wrongNameObject = new SandboxDurableObject(
            createState('sandbox-wrong'),
            {},
            {
                clientFactory: (_state, options) => new FakeClient(options.workspace),
            },
        );
        await expect(
            wrongNameObject.initialize({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' }),
        ).rejects.toMatchObject({ code: 'invalid-workspace' });

        expect(await state.storage.get('workspace')).toEqual(
            await createSandboxWorkspace({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' }),
        );
    });

    it('requires initialization before use and passes typed timeout errors through', async () => {
        const uninitialized = new SandboxDurableObject(
            createState(),
            {},
            {
                clientFactory: (_state, options) => new FakeClient(options.workspace),
            },
        );
        await expect(uninitialized.exec('pwd')).rejects.toMatchObject({ code: 'not-initialized' });

        const { object, clients } = await createFixture();
        await object.initialize({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' });
        await object.exec('pwd');
        clients[0]!.execHandler = async () => {
            throw new SandboxTimeoutError('timed out');
        };
        await expect(object.exec('sleep 10', { timeoutMs: 10 })).rejects.toBeInstanceOf(SandboxTimeoutError);
    });

    it('cancels in-flight operations', async () => {
        const { object, clients } = await createFixture();
        await object.initialize({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' });
        await object.exec('pwd');
        clients[0]!.execHandler = (_command, options) =>
            new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new SandboxAbortError('cancelled')), {
                    once: true,
                });
            });

        const pending = object.exec('sleep 10');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(object.cancelAll()).toBe(1);
        await expect(pending).rejects.toBeInstanceOf(SandboxAbortError);
        expect(await object.getStatus()).toMatchObject({ activeOperations: 0 });
    });

    it('destroys the client and requires initialization again', async () => {
        const { object, state, clients } = await createFixture();
        await object.initialize({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' });
        await object.exec('pwd');
        expect(clients).toHaveLength(1);

        await object.destroy();
        expect(clients[0]!.destroyed).toBe(true);
        expect(await object.getStatus()).toEqual({ workspace: null, hasClient: false, activeOperations: 0 });
        await expect(object.exec('pwd')).rejects.toBeInstanceOf(SandboxDisposedError);
        expect(await state.storage.get('workspace')).toBeUndefined();

        await object.initialize({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' });
        await object.exec('pwd');
        expect(clients).toHaveLength(2);
    });

    it('wraps client factory failures as internal sandbox errors', async () => {
        const { object } = await createFixture();
        await object.initialize({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' });

        const broken = new SandboxDurableObject(
            createState(),
            {},
            {
                clientFactory: () => {
                    throw new Error('factory failed');
                },
            },
        );
        await broken.initialize({ userId: 'alice', repository: 'owner/repo', sessionId: 's1' });
        await expect(broken.exec('pwd')).rejects.toMatchObject({ code: 'internal' });
    });

    it('starts and destroys the Cloudflare adapter through the Durable Object', async () => {
        const scope = { userId: 'alice', repository: 'owner/repo', sessionId: 's1' };
        const workspace = await createSandboxWorkspace(scope);
        const container = new FakeContainer();
        const object = new SandboxDurableObject(createState(workspace.name, container));

        await object.initialize(scope);
        expect(await object.exec('echo hi')).toMatchObject({ exitCode: 0, stdout: 'hello' });
        expect(container.startOptions).toMatchObject({
            image: 'registry.example/sandbox:1.0.3',
            enableInternet: false,
            instance: 'basic',
        });
        expect(container.startOptions).not.toHaveProperty('env');
        expect(container.execCalls[0]).toEqual(['bash', '-lc', 'echo hi']);

        await object.destroy();
        expect(container.destroyed).toBe(true);
    });

    it('keeps the mock adapter usable through the Durable Object contract', async () => {
        const workspace = await createSandboxWorkspace({ userId: 'alice', repository: 'owner/repo' });
        const object = new SandboxDurableObject(
            createState(workspace.name),
            {},
            {
                clientFactory: (_state, options) => new MockSandboxClient({ workspace: options.workspace }),
            },
        );
        await object.initialize({ userId: 'alice', repository: 'owner/repo' });
        await object.writeFile('hello.txt', 'world');
        expect(new TextDecoder().decode(await object.readFile('hello.txt'))).toBe('world');
        expect(await object.exec('echo hi')).toMatchObject({ exitCode: 0, stdout: '' });
    });
});
