import type { SandboxDirectoryEntry } from '@cloudflare/sandbox';
import { describe, expect, it } from 'vitest';
import {
    CloudflareSandboxClient,
    type CloudflareContainer,
    type CloudflareContainerStartOptions,
    type CloudflareExecProcess,
    type CloudflareFiles,
} from './cloudflare';
import { SandboxAbortError, SandboxDisposedError, SandboxLimitError, SandboxTimeoutError } from './errors';
import { createSandboxWorkspace } from './workspace';

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

function neverEndingStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start() {
            // Keep the stream open until the test cancels it.
        },
    });
}

class FakeProcess implements CloudflareExecProcess {
    readonly stdout: ReadableStream<Uint8Array> | null;
    readonly stderr: ReadableStream<Uint8Array> | null;
    readonly exitCode: Promise<number>;
    killed = false;

    constructor(stdout = 'ok', stderr = '', exitCode = 0, neverExit = false) {
        this.stdout = neverExit ? neverEndingStream() : streamOf(stdout);
        this.stderr = neverExit ? neverEndingStream() : streamOf(stderr);
        this.exitCode = neverExit ? new Promise<number>(() => undefined) : Promise.resolve(exitCode);
    }

    kill(): void {
        this.killed = true;
    }
}

class FakeContainer implements CloudflareContainer {
    readonly images = { workspace: 'registry.example/sandbox:1.0.3' };
    running = false;
    destroyed = false;
    inactivityTimeout: number | undefined;
    startOptions: CloudflareContainerStartOptions | undefined;
    execCalls: Array<{ cmd: string[]; options?: { cwd?: string; signal?: AbortSignal } }> = [];
    nextProcess: FakeProcess | undefined;

    start(options: CloudflareContainerStartOptions): void {
        this.startOptions = options;
        this.running = true;
    }

    async destroy(): Promise<void> {
        this.running = false;
        this.destroyed = true;
    }

    async setInactivityTimeout(durationMs: number | bigint): Promise<void> {
        this.inactivityTimeout = Number(durationMs);
    }

    async snapshotContainer(options?: { name?: string }): Promise<{ id: string; size: number; name?: string }> {
        return { id: 'snapshot-1', size: 42, name: options?.name };
    }

    async exec(cmd: string[], options?: { cwd?: string; signal?: AbortSignal }): Promise<CloudflareExecProcess> {
        this.execCalls.push({ cmd, options });
        return this.nextProcess ?? new FakeProcess();
    }
}

class FakeFiles implements CloudflareFiles {
    readonly files = new Map<string, Uint8Array>();
    readonly directories = new Set<string>(['/workspace/repo']);
    readonly calls: string[] = [];

    async readFile(path: string): Promise<Response> {
        this.calls.push(`read:${path}`);
        const content = this.files.get(path);
        if (!content) {
            throw new Error(`ENOENT: ${path}`);
        }
        return new Response(content as unknown as BodyInit);
    }

    async writeFile(
        path: string,
        content: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream,
    ): Promise<void> {
        this.calls.push(`write:${path}`);
        if (typeof content === 'string') {
            this.files.set(path, new TextEncoder().encode(content));
        } else if (content instanceof Uint8Array) {
            this.files.set(path, new Uint8Array(content));
        } else if (content instanceof ArrayBuffer) {
            this.files.set(path, new Uint8Array(content));
        } else {
            throw new Error('Unsupported test content');
        }
    }

    async rename(source: string, destination: string): Promise<void> {
        this.calls.push(`rename:${source}:${destination}`);
        const content = this.files.get(source);
        if (!content) {
            throw new Error(`ENOENT: ${source}`);
        }
        this.files.delete(source);
        this.files.set(destination, content);
    }

    async remove(path: string): Promise<void> {
        this.calls.push(`remove:${path}`);
        this.files.delete(path);
    }

    async mkdir(path: string): Promise<void> {
        this.calls.push(`mkdir:${path}`);
        this.directories.add(path);
    }

    async readDirectory(path: string): Promise<SandboxDirectoryEntry[]> {
        this.calls.push(`list:${path}`);
        return [
            { name: 'src', type: 'directory' },
            { name: 'link', type: 'symlink' },
            { name: 'device', type: 'socket' },
        ];
    }
}

async function createClient(
    options: { enableInternet?: boolean } = {},
    files = new FakeFiles(),
): Promise<{
    client: CloudflareSandboxClient;
    container: FakeContainer;
    files: FakeFiles;
}> {
    const container = new FakeContainer();
    const client = new CloudflareSandboxClient({
        workspace: await createSandboxWorkspace({ userId: '123', repository: 'owner/repo' }, '/workspace/repo'),
        container,
        files,
        instance: 'basic',
        enableInternet: options.enableInternet,
        inactivityTimeoutMs: 5_000,
        maxFileBytes: 16,
    });
    return { client, container, files };
}

describe('CloudflareSandboxClient', () => {
    it('starts with internet disabled and runs commands without secrets', async () => {
        const { client, container } = await createClient();
        const result = await client.exec('echo hello', { cwd: 'src', timeoutMs: 1_000 });

        expect(result).toMatchObject({ command: 'echo hello', cwd: '/workspace/repo/src', exitCode: 0 });
        expect(result.stdout).toBe('ok');
        expect(container.startOptions).toMatchObject({
            image: 'registry.example/sandbox:1.0.3',
            enableInternet: false,
            instance: 'basic',
        });
        expect(container.startOptions).not.toHaveProperty('env');
        expect(container.inactivityTimeout).toBe(5_000);
        expect(container.execCalls[0]?.cmd).toEqual(['bash', '-lc', 'echo hello']);
        expect(container.execCalls[0]?.options?.cwd).toBe('/workspace/repo/src');
    });

    it('can opt in to container internet access', async () => {
        const { client, container } = await createClient({ enableInternet: true });
        await client.exec('npm ci', { timeoutMs: 1_000 });
        expect(container.startOptions).toMatchObject({ enableInternet: true });
    });

    it('truncates command output at the configured limit', async () => {
        const { client, container } = await createClient();
        container.nextProcess = new FakeProcess('abcdef', 'ghijkl');
        const result = await client.exec('echo long', { maxOutputBytes: 3 });

        expect(result.stdout).toBe('abc');
        expect(result.stderr).toBe('ghi');
        expect(result.truncated).toBe(true);
    });

    it('kills a command on timeout', async () => {
        const { client, container } = await createClient();
        const process = new FakeProcess('', '', 0, true);
        container.nextProcess = process;

        await expect(client.exec('sleep 10', { timeoutMs: 10 })).rejects.toBeInstanceOf(SandboxTimeoutError);
        expect(process.killed).toBe(true);
    });

    it('kills a command when its signal is aborted', async () => {
        const { client, container } = await createClient();
        const process = new FakeProcess('', '', 0, true);
        container.nextProcess = process;
        const controller = new AbortController();
        const pending = client.exec('sleep 10', { signal: controller.signal, timeoutMs: 10_000 });
        controller.abort();

        await expect(pending).rejects.toBeInstanceOf(SandboxAbortError);
        expect(process.killed).toBe(true);
    });

    it('maps file operations to the workspace root', async () => {
        const { client, files } = await createClient();
        await client.writeFile('src/app.ts', 'hello');
        expect(files.calls).toContain('mkdir:/workspace/repo/src');
        expect(files.calls).toContain('write:/workspace/repo/src/app.ts');

        files.files.set('/workspace/repo/src/app.ts', new TextEncoder().encode('hello'));
        expect(new TextDecoder().decode(await client.readFile('src/app.ts'))).toBe('hello');
        expect(await client.list('src')).toEqual({
            path: 'src',
            entries: [
                { name: 'device', type: 'other' },
                { name: 'link', type: 'symlink' },
                { name: 'src', type: 'directory' },
            ],
            truncated: false,
        });

        await client.rename('src/app.ts', 'src/main.ts');
        await client.remove('src/app.ts', { force: true });
        expect(files.calls).toContain('rename:/workspace/repo/src/app.ts:/workspace/repo/src/main.ts');
        expect(files.calls).toContain('remove:/workspace/repo/src/app.ts');
    });

    it('enforces read limits and snapshots/destroys the container', async () => {
        const { client, files, container } = await createClient();
        files.files.set('/workspace/repo/a.txt', new TextEncoder().encode('abcdef'));
        await expect(client.readFile('a.txt', { maxBytes: 2 })).rejects.toBeInstanceOf(SandboxLimitError);

        const snapshot = await client.snapshot({ name: 'checkpoint' });
        expect(snapshot).toMatchObject({ id: 'snapshot-1', size: 42, name: 'checkpoint' });

        await client.destroy();
        expect(container.destroyed).toBe(true);
        await expect(client.exec('pwd')).rejects.toBeInstanceOf(SandboxDisposedError);
    });
});
