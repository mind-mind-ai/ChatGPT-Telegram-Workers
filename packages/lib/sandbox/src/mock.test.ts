import { describe, expect, it } from 'vitest';
import {
    SandboxAbortError,
    SandboxDisposedError,
    SandboxFileError,
    SandboxLimitError,
    SandboxTimeoutError,
} from './errors';
import { MockSandboxClient } from './mock';
import type { SandboxClient } from './types';
import { createSandboxWorkspace } from './workspace';

async function createClient(): Promise<MockSandboxClient> {
    return new MockSandboxClient({
        workspace: await createSandboxWorkspace({ userId: '123', repository: 'owner/repo' }),
    });
}

describe('MockSandboxClient', () => {
    it('reads, writes, lists, renames, and removes files', async () => {
        const client = await createClient();
        await client.writeFile('src/app.ts', 'export const value = 1;\n');

        expect(new TextDecoder().decode(await client.readFile('src/app.ts'))).toContain('value = 1');
        expect(await client.list()).toEqual({
            path: '',
            entries: [{ name: 'src', type: 'directory' }],
            truncated: false,
        });
        expect(await client.list('src')).toEqual({
            path: 'src',
            entries: [{ name: 'app.ts', type: 'file' }],
            truncated: false,
        });

        await client.rename('src/app.ts', 'src/main.ts');
        expect(await client.list('src')).toEqual({
            path: 'src',
            entries: [{ name: 'main.ts', type: 'file' }],
            truncated: false,
        });

        await client.remove('src', { recursive: true });
        expect(await client.list()).toEqual({ path: '', entries: [], truncated: false });
    });

    it('returns command results and enforces the output limit', async () => {
        const client = new MockSandboxClient({
            workspace: await createSandboxWorkspace({ userId: '123', repository: 'owner/repo' }),
            execHandler: () => ({ stdout: 'abcdef', stderr: 'error', exitCode: 2 }),
        });
        const result = await client.exec('npm test', { maxOutputBytes: 3 });

        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe('abc');
        expect(result.stderr).toBe('err');
        expect(result.truncated).toBe(true);
        expect(client.commands).toEqual(['npm test']);
    });

    it('supports cancellation and timeouts', async () => {
        const client = new MockSandboxClient({
            workspace: await createSandboxWorkspace({ userId: '123', repository: 'owner/repo' }),
            execHandler: () => new Promise(() => undefined),
        });
        await expect(client.exec('sleep 10', { timeoutMs: 10 })).rejects.toBeInstanceOf(SandboxTimeoutError);

        const controller = new AbortController();
        const pending = client.exec('sleep 10', { signal: controller.signal, timeoutMs: 10_000 });
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(SandboxAbortError);
    });

    it('enforces file and list limits', async () => {
        const client = new MockSandboxClient({
            workspace: await createSandboxWorkspace({ userId: '123', repository: 'owner/repo' }),
            files: { 'a.txt': '1234', 'b.txt': '1234' },
        });
        await expect(client.readFile('a.txt', { maxBytes: 2 })).rejects.toBeInstanceOf(SandboxLimitError);
        expect(await client.list('', { maxEntries: 1 })).toMatchObject({
            truncated: true,
            entries: [{ name: 'a.txt' }],
        });
    });

    it('reports missing files and protects the workspace root', async () => {
        const client = await createClient();
        await expect(client.readFile('missing.txt')).rejects.toBeInstanceOf(SandboxFileError);
        await expect(client.writeFile('', 'x')).rejects.toBeInstanceOf(SandboxFileError);
        await expect(client.remove('', { recursive: true })).rejects.toBeInstanceOf(SandboxFileError);
    });

    it('keeps separate users and repositories isolated through the SandboxClient interface', async () => {
        const alice: SandboxClient = new MockSandboxClient({
            workspace: await createSandboxWorkspace({ userId: 'alice', repository: 'owner/repo' }),
        });
        const bob: SandboxClient = new MockSandboxClient({
            workspace: await createSandboxWorkspace({ userId: 'bob', repository: 'owner/repo' }),
        });
        await alice.writeFile('secret.txt', 'alice-only');

        expect(alice.workspace.name).not.toBe(bob.workspace.name);
        await expect(bob.readFile('secret.txt')).rejects.toBeInstanceOf(SandboxFileError);
        expect(await alice.readFile('secret.txt')).toEqual(new TextEncoder().encode('alice-only'));
    });

    it('takes snapshots and destroys the client', async () => {
        const client = await createClient();
        await client.writeFile('a.txt', 'hello');
        const snapshot = await client.snapshot({ name: 'checkpoint' });
        expect(snapshot.name).toBe('checkpoint');
        expect(snapshot.size).toBe(5);

        await client.destroy();
        await expect(client.readFile('a.txt')).rejects.toBeInstanceOf(SandboxDisposedError);
        await expect(client.exec('pwd')).rejects.toBeInstanceOf(SandboxDisposedError);
    });
});
