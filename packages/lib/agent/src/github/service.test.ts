import { zipSync } from 'fflate';
import { MockSandboxClient, createSandboxWorkspace } from '@chatgpt-telegram-workers/sandbox';
import { describe, expect, it, vi } from 'vitest';
import { StaticGitHubAuthorizationProvider } from './authorization';
import type { GitHubTokenProvider } from './auth';
import { normalizeGitHubRepository } from './repository';
import { GitHubService } from './service';
import type { GitHubAccessContext, GitHubRepositoryRef } from './types';

const ACCESS: GitHubAccessContext = { userId: 'alice', repository: 'octo/public', sessionId: 's1' };
const PUBLIC = normalizeGitHubRepository('octo/public');
const PRIVATE = normalizeGitHubRepository('octo/private');
const ROOT = 'octo-public-0123456789abcdef';
const text = (value: string) => new TextEncoder().encode(value);

function repositoryZip(files: Record<string, string>, root = ROOT): Uint8Array {
    return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [`${root}/${path}`, text(value)])));
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

function zipResponse(bytes: Uint8Array): Response {
    return new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/zip' } });
}

interface FetchCall {
    url: string;
    method: string;
    headers: Record<string, string>;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        calls.push({ url, method: init.method ?? 'GET', headers });
        return handler(url, init);
    }) as typeof fetch;
    return { fetchImpl, calls };
}

function metadata(repository: GitHubRepositoryRef, overrides: Record<string, unknown> = {}) {
    return {
        full_name: repository.fullName,
        private: repository === PRIVATE,
        default_branch: 'main',
        description: 'Demo repository',
        html_url: `https://github.com/${repository.fullName}`,
        language: 'TypeScript',
        size: 42,
        archived: false,
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

function serviceWith(
    repositories: string[],
    fetchImpl: typeof fetch,
    options: {
        installationId?: string;
        tokenProvider?: GitHubTokenProvider;
        timeoutMs?: number;
        maxArchiveBytes?: number;
        maxFileBytes?: number;
    } = {},
): GitHubService {
    return new GitHubService({
        authorization: new StaticGitHubAuthorizationProvider({
            repositories,
            ...(options.installationId ? { installationId: options.installationId } : {}),
        }),
        ...(options.tokenProvider ? { tokenProvider: options.tokenProvider } : {}),
        fetchImpl,
        apiBaseUrl: 'https://api.github.test',
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: options.maxArchiveBytes }),
        ...(options.maxFileBytes === undefined ? {} : { archiveLimits: { maxFileBytes: options.maxFileBytes } }),
    });
}

describe('GitHubService repository retrieval', () => {
    it('retrieves public metadata and checks out repository files into the sandbox without credentials', async () => {
        const zip = repositoryZip({ 'README.md': 'hello', 'src/a.ts': 'export const a = 1;\n' });
        const { fetchImpl, calls } = fakeFetch(url => {
            if (url.endsWith('/repos/octo/public')) {
                return jsonResponse(metadata(PUBLIC));
            }
            if (url.includes('/zipball/main')) {
                return zipResponse(zip);
            }
            return jsonResponse({}, 404);
        });
        const service = serviceWith(['octo/public'], fetchImpl);

        const info = await service.getRepository('octo/public', ACCESS);
        expect(info).toMatchObject({
            fullName: 'octo/public',
            defaultBranch: 'main',
            private: false,
            sizeKb: 42,
        });

        const workspace = await createSandboxWorkspace({ ...ACCESS, repository: 'octo/public' });
        const sandbox = new MockSandboxClient({ workspace, files: { 'stale.txt': 'old' } });
        const result = await service.checkoutRepository('octo/public', ACCESS, sandbox);

        expect(result).toMatchObject({ ref: 'main', filesWritten: 2, bytesWritten: 25 });
        expect(await sandbox.list('')).toMatchObject({
            entries: [
                { name: 'README.md', type: 'file' },
                { name: 'src', type: 'directory' },
            ],
        });
        expect(new TextDecoder().decode(await sandbox.readFile('README.md'))).toBe('hello');
        await expect(sandbox.readFile('stale.txt')).rejects.toThrow();
        expect(calls.every(call => call.method === 'GET')).toBe(true);
        expect(calls.every(call => !call.headers.authorization)).toBe(true);
        expect(JSON.stringify(calls)).not.toContain('ghs_');
    });

    it('uses a repository-scoped installation token for private repositories and keeps it out of outputs', async () => {
        const token = 'ghs_private_secret';
        const zip = repositoryZip({ 'README.md': 'private' });
        const tokenProvider: GitHubTokenProvider = {
            getInstallationToken: vi.fn(async () => ({ token, expiresAt: Date.now() + 3_600_000 })),
        };
        const { fetchImpl, calls } = fakeFetch(url => {
            if (url.endsWith('/repos/octo/private')) {
                return jsonResponse(metadata(PRIVATE));
            }
            if (url.includes('/zipball/main')) {
                return zipResponse(zip);
            }
            return jsonResponse({}, 404);
        });
        const service = serviceWith(['octo/private'], fetchImpl, {
            installationId: '123',
            tokenProvider,
        });

        const workspace = await createSandboxWorkspace({ ...ACCESS, repository: 'octo/private' });
        const sandbox = new MockSandboxClient({ workspace });
        const result = await service.checkoutRepository(
            'octo/private',
            { ...ACCESS, repository: 'octo/private' },
            sandbox,
        );

        expect(result.filesWritten).toBe(1);
        expect(tokenProvider.getInstallationToken).toHaveBeenCalledWith('123', expect.objectContaining(PRIVATE), {
            signal: undefined,
        });
        expect(calls.some(call => call.headers.authorization === `Bearer ${token}`)).toBe(true);
        expect(calls.every(call => call.method === 'GET')).toBe(true);
        expect(JSON.stringify(result)).not.toContain(token);
        expect(new TextDecoder().decode(await sandbox.readFile('README.md'))).not.toContain(token);
        expect(sandbox.commands).toEqual([]);
    });

    it('rejects unauthorized repositories before any GitHub request', async () => {
        const { fetchImpl, calls } = fakeFetch(() => jsonResponse({}));
        const service = serviceWith(['octo/public'], fetchImpl);

        await expect(service.getRepository('octo/private', ACCESS)).rejects.toMatchObject({
            code: 'unauthorized',
        });
        expect(calls).toHaveLength(0);
    });

    it('rejects invalid repository identifiers before any GitHub request', async () => {
        const { fetchImpl, calls } = fakeFetch(() => jsonResponse({}));
        const service = serviceWith(['octo/public'], fetchImpl);

        for (const repository of ['../etc/passwd', 'octo/public/extra', 'octo/..', 'bad owner/repo']) {
            await expect(service.getRepository(repository, ACCESS)).rejects.toMatchObject({
                code: 'invalid-repository',
            });
        }
        expect(calls).toHaveLength(0);
    });

    it('maps authentication failures and does not leak the response body', async () => {
        const tokenProvider: GitHubTokenProvider = {
            getInstallationToken: vi.fn(async () => ({ token: 'ghs_secret', expiresAt: Date.now() + 3_600_000 })),
        };
        const { fetchImpl } = fakeFetch(
            () =>
                new Response(JSON.stringify({ message: 'bad token ghs_secret' }), {
                    status: 401,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const service = serviceWith(['octo/private'], fetchImpl, { installationId: '123', tokenProvider });

        await expect(
            service.getRepository('octo/private', { ...ACCESS, repository: 'octo/private' }),
        ).rejects.toMatchObject({ code: 'auth' });
        try {
            await service.getRepository('octo/private', { ...ACCESS, repository: 'octo/private' });
        } catch (error) {
            expect((error as Error).message).not.toContain('ghs_secret');
        }
    });

    it('maps rate limits and retry hints', async () => {
        const { fetchImpl } = fakeFetch(
            () =>
                new Response(JSON.stringify({ message: 'rate limited' }), {
                    status: 429,
                    headers: { 'content-type': 'application/json', 'retry-after': '60' },
                }),
        );
        const service = serviceWith(['octo/public'], fetchImpl);
        await expect(service.getRepository('octo/public', ACCESS)).rejects.toMatchObject({
            code: 'rate-limit',
            retryAfterSeconds: 60,
        });
    });

    it('times out stalled GitHub requests', async () => {
        const { fetchImpl } = fakeFetch(() => new Promise(() => {}));
        const service = serviceWith(['octo/public'], fetchImpl, { timeoutMs: 5 });
        await expect(service.getRepository('octo/public', ACCESS)).rejects.toMatchObject({ code: 'timeout' });
    });

    it('enforces archive limits for large repositories', async () => {
        const zip = repositoryZip({ 'large.txt': 'x'.repeat(100) });
        const { fetchImpl } = fakeFetch(url => {
            if (url.endsWith('/repos/octo/public')) {
                return jsonResponse(metadata(PUBLIC));
            }
            return zipResponse(zip);
        });
        const service = serviceWith(['octo/public'], fetchImpl, { maxFileBytes: 10 });
        await expect(service.downloadRepository('octo/public', ACCESS)).rejects.toMatchObject({ code: 'limit' });
    });

    it('rejects archives larger than the download limit', async () => {
        const zip = repositoryZip({ 'README.md': 'x'.repeat(1_000) });
        const { fetchImpl } = fakeFetch(url => {
            if (url.endsWith('/repos/octo/public')) {
                return jsonResponse(metadata(PUBLIC));
            }
            return zipResponse(zip);
        });
        const service = serviceWith(['octo/public'], fetchImpl, { maxArchiveBytes: 10 });
        await expect(service.downloadRepository('octo/public', ACCESS)).rejects.toMatchObject({ code: 'limit' });
    });

    it('blocks archive redirects to untrusted hosts', async () => {
        const { fetchImpl, calls } = fakeFetch(url => {
            if (url.endsWith('/repos/octo/public')) {
                return jsonResponse(metadata(PUBLIC));
            }
            return new Response(null, {
                status: 302,
                headers: { location: 'https://evil.example/archive.zip' },
            });
        });
        const service = serviceWith(['octo/public'], fetchImpl);
        await expect(service.downloadRepository('octo/public', ACCESS)).rejects.toMatchObject({ code: 'api' });
        expect(calls).toHaveLength(2);
    });

    it('reports sandbox transfer failures as sandbox errors', async () => {
        const zip = repositoryZip({ 'README.md': 'hello' });
        const { fetchImpl } = fakeFetch(url => {
            if (url.endsWith('/repos/octo/public')) {
                return jsonResponse(metadata(PUBLIC));
            }
            return zipResponse(zip);
        });
        const service = serviceWith(['octo/public'], fetchImpl);
        const workspace = await createSandboxWorkspace({ ...ACCESS, repository: 'octo/public' });
        class FailingSandbox extends MockSandboxClient {
            override async writeFile(): Promise<void> {
                throw new Error('disk full');
            }
        }
        const sandbox = new FailingSandbox({ workspace });
        await expect(service.checkoutRepository('octo/public', ACCESS, sandbox)).rejects.toMatchObject({
            code: 'sandbox',
        });
    });
});
