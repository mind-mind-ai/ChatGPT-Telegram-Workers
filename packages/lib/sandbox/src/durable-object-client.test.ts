import { describe, expect, it } from 'vitest';
import { DurableObjectSandboxClient, createDurableObjectSandboxClient } from './durable-object-client';
import type { SandboxDurableObjectStub, SandboxNamespaceBinding } from './durable-object';
import { SandboxAbortError, SandboxDisposedError } from './errors';
import { MockSandboxClient } from './mock';
import type {
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

class FakeStub implements SandboxDurableObjectStub {
    readonly mock: MockSandboxClient;
    readonly calls: string[] = [];
    cancelled = 0;
    destroyed = false;
    execHandler: ((command: string, options?: SandboxExecOptions) => Promise<SandboxExecResult>) | undefined;

    constructor(readonly workspace: SandboxWorkspace) {
        this.mock = new MockSandboxClient({ workspace, files: { 'README.md': '# demo\n' } });
    }

    async initialize(scope: SandboxScope): Promise<SandboxWorkspace> {
        this.calls.push(`initialize:${scope.userId}:${scope.repository}:${scope.sessionId ?? 'default'}`);
        return this.workspace;
    }

    async getStatus() {
        return { workspace: this.workspace, hasClient: true, activeOperations: 0 };
    }

    async exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
        this.calls.push(`exec:${command}`);
        return this.execHandler ? this.execHandler(command, options) : this.mock.exec(command, options);
    }

    async readFile(path: string, options: SandboxFileOptions = {}): Promise<Uint8Array> {
        this.calls.push(`read:${path}`);
        return this.mock.readFile(path, options);
    }

    async writeFile(path: string, content: SandboxFileContent, options: SandboxFileOptions = {}): Promise<void> {
        this.calls.push(`write:${path}`);
        await this.mock.writeFile(path, content, options);
    }

    async rename(from: string, to: string, options: SandboxFileOptions = {}): Promise<void> {
        this.calls.push(`rename:${from}:${to}`);
        await this.mock.rename(from, to, options);
    }

    async remove(path: string, options: SandboxRemoveOptions = {}): Promise<void> {
        this.calls.push(`remove:${path}`);
        await this.mock.remove(path, options);
    }

    async list(path = '', options: SandboxListOptions = {}): Promise<SandboxListResult> {
        this.calls.push(`list:${path}`);
        return this.mock.list(path, options);
    }

    async snapshot(options: SandboxSnapshotOptions = {}): Promise<SandboxSnapshot> {
        this.calls.push('snapshot');
        return this.mock.snapshot(options);
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
        await this.mock.destroy();
    }

    async cancelAll(): Promise<number> {
        this.cancelled++;
        return 1;
    }
}

async function createFixture() {
    const scope = { userId: 'alice', repository: 'owner/repo', sessionId: 's1' };
    const workspace = await createSandboxWorkspace(scope);
    const stub = new FakeStub(workspace);
    let requestedName = '';
    const namespace: SandboxNamespaceBinding = {
        getByName(name) {
            requestedName = name;
            return stub;
        },
    };
    const client = await createDurableObjectSandboxClient(namespace, scope);
    return { scope, workspace, stub, client, requestedName };
}

describe('DurableObjectSandboxClient', () => {
    it('resolves the workspace DO by name and delegates SandboxClient operations', async () => {
        const { workspace, stub, client, requestedName } = await createFixture();

        expect(requestedName).toBe(workspace.name);
        expect(new TextDecoder().decode(await client.readFile('README.md'))).toBe('# demo\n');

        await client.writeFile('src/a.ts', 'hello');
        expect(await client.list('src')).toMatchObject({ path: 'src', entries: [{ name: 'a.ts', type: 'file' }] });
        await client.rename('src/a.ts', 'src/b.ts');
        await client.remove('src/b.ts');
        await client.snapshot({ name: 'checkpoint' });
        await client.exec('echo hi', { cwd: 'src', timeoutMs: 1_000, maxOutputBytes: 128 });
        expect(stub.calls).toContain('initialize:alice:owner/repo:s1');
        expect(stub.calls).toContain('exec:echo hi');
    });

    it('cancels the remote DO operation when the local signal aborts', async () => {
        const { stub, client } = await createFixture();
        stub.execHandler = () => new Promise(() => {});

        const controller = new AbortController();
        const pending = client.exec('sleep 10', { signal: controller.signal });
        await new Promise(resolve => setTimeout(resolve, 0));
        controller.abort();

        await expect(pending).rejects.toBeInstanceOf(SandboxAbortError);
        expect(stub.cancelled).toBeGreaterThan(0);
    });

    it('destroys the DO and rejects later operations', async () => {
        const { stub, client } = await createFixture();
        await client.exec('pwd');
        await client.destroy();
        expect(stub.destroyed).toBe(true);
        await expect(client.exec('pwd')).rejects.toBeInstanceOf(SandboxDisposedError);
    });

    it('rejects a missing binding and a mismatched workspace', async () => {
        await expect(
            createDurableObjectSandboxClient(null, { userId: 'alice', repository: 'owner/repo' }),
        ).rejects.toMatchObject({ code: 'unsupported' });

        const workspace = await createSandboxWorkspace({ userId: 'alice', repository: 'owner/repo' });
        const stub = new FakeStub(workspace);
        expect(
            () => new DurableObjectSandboxClient(workspace, { userId: 'bob', repository: 'owner/repo' }, stub),
        ).toThrow(/does not match the workspace/);
    });
});
