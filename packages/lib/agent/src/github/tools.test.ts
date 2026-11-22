import { zipSync } from 'fflate';
import { MockSandboxClient, createSandboxWorkspace } from '@chatgpt-telegram-workers/sandbox';
import { describe, expect, it, vi } from 'vitest';
import type { CompletionResult, ToolCall } from '@chatgpt-telegram-workers/ai';
import { AgentRuntime } from '../runtime';
import type { AgentLLMRequest } from '../runtime';
import { ToolRegistry } from '../tools';
import { StaticGitHubAuthorizationProvider } from './authorization';
import type { GitHubTokenProvider } from './auth';
import { CODING_TOOL_PERMISSION } from '../coding/constants';
import { GitHubService } from './service';
import { registerGitHubTools } from './tools';

const PUBLIC_SCOPE = { userId: 'alice', repository: 'octo/public', sessionId: 's1' };
const PRIVATE_SCOPE = { userId: 'alice', repository: 'octo/private', sessionId: 's1' };
const PUBLIC_ACCESS = { ...PUBLIC_SCOPE, permissions: [CODING_TOOL_PERMISSION] };
const PRIVATE_ACCESS = { ...PRIVATE_SCOPE, permissions: [CODING_TOOL_PERMISSION] };
const ROOT = 'octo-public-0123456789abcdef';
const text = (value: string) => new TextEncoder().encode(value);

function repositoryZip(files: Record<string, string>, root = ROOT): Uint8Array {
    return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [`${root}/${path}`, text(value)])));
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function zipResponse(bytes: Uint8Array): Response {
    return new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/zip' } });
}

function metadata(fullName: string, isPrivate = false) {
    return {
        full_name: fullName,
        private: isPrivate,
        default_branch: 'main',
        description: 'Demo',
        html_url: `https://github.com/${fullName}`,
        language: 'TypeScript',
        size: 10,
        archived: false,
    };
}

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({
            url,
            method: init.method ?? 'GET',
            headers: Object.fromEntries(new Headers(init.headers).entries()),
        });
        return handler(url);
    }) as typeof fetch;
    return { fetchImpl, calls };
}

async function publicFixture() {
    const zip = repositoryZip({ 'README.md': 'hello', 'src/a.ts': 'export const a = 1;\n' });
    const { fetchImpl, calls } = fakeFetch(url => {
        if (url.endsWith('/repos/octo/public')) {
            return jsonResponse(metadata('octo/public'));
        }
        if (url.includes('/zipball/main')) {
            return zipResponse(zip);
        }
        return jsonResponse({}, 404);
    });
    const service = new GitHubService({
        authorization: new StaticGitHubAuthorizationProvider({
            repositories: ['octo/public', 'octo/other'],
        }),
        fetchImpl,
        apiBaseUrl: 'https://api.github.test',
    });
    const workspace = await createSandboxWorkspace(PUBLIC_SCOPE);
    const sandbox = new MockSandboxClient({ workspace, files: { 'stale.txt': 'old' } });
    const registry = new ToolRegistry();
    registerGitHubTools(registry, { service, sandbox });
    const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
        id: `${name}-1`,
        name,
        arguments: JSON.stringify(args),
    });
    return { registry, sandbox, calls, call };
}

async function privateFixture() {
    const token = 'ghs_tool_private_secret';
    const tokenProvider: GitHubTokenProvider = {
        getInstallationToken: vi.fn(async () => ({ token, expiresAt: Date.now() + 3_600_000 })),
    };
    const zip = repositoryZip({ 'README.md': 'private' }, 'octo-private-0123456789abcdef');
    const { fetchImpl, calls } = fakeFetch(url => {
        if (url.endsWith('/repos/octo/private')) {
            return jsonResponse(metadata('octo/private', true));
        }
        if (url.includes('/zipball/main')) {
            return zipResponse(zip);
        }
        return jsonResponse({}, 404);
    });
    const service = new GitHubService({
        authorization: new StaticGitHubAuthorizationProvider({
            repositories: ['octo/private'],
            installationId: '123',
        }),
        tokenProvider,
        fetchImpl,
        apiBaseUrl: 'https://api.github.test',
    });
    const workspace = await createSandboxWorkspace(PRIVATE_SCOPE);
    const sandbox = new MockSandboxClient({ workspace });
    const registry = new ToolRegistry();
    registerGitHubTools(registry, { service, sandbox });
    return { registry, sandbox, calls, token };
}

describe('registerGitHubTools', () => {
    it('registers read-only GitHub tools behind the existing coding permission', async () => {
        const { registry } = await publicFixture();
        expect(registry.size).toBe(3);
        expect(registry.definitions()).toEqual([]);
        expect(registry.definitions({ permissions: ['web'] })).toEqual([]);
        expect(registry.definitions({ permissions: [CODING_TOOL_PERMISSION] }).map(tool => tool.name)).toEqual([
            'repo_list',
            'repo_info',
            'repo_checkout',
        ]);
    });
});

describe('GitHub tools', () => {
    it('lists authorized repositories and reads repository metadata', async () => {
        const { registry, call } = await publicFixture();
        const list = await registry.execute(call('repo_list'), PUBLIC_ACCESS);
        expect(list.isError).toBeFalsy();
        expect(list.content).toContain('octo/public');
        expect(list.content).toContain('octo/other');

        const info = await registry.execute(call('repo_info'), PUBLIC_ACCESS);
        expect(info.isError).toBeFalsy();
        expect(info.content).toContain('Repository: octo/public');
        expect(info.content).toContain('Default branch: main');
    });

    it('checks out the authorized repository and replaces stale workspace contents', async () => {
        const { registry, sandbox, call } = await publicFixture();
        const result = await registry.execute(call('repo_checkout'), PUBLIC_ACCESS);

        expect(result.isError).toBeFalsy();
        expect(result.content).toContain('Checked out octo/public at main');
        expect(result.content).toContain('untrusted data');
        expect(new TextDecoder().decode(await sandbox.readFile('README.md'))).toBe('hello');
        await expect(sandbox.readFile('stale.txt')).rejects.toThrow();
        expect(sandbox.commands).toEqual([]);
    });

    it('denies users, repositories and sessions that do not own the sandbox', async () => {
        const { registry, calls, call } = await publicFixture();
        for (const access of [
            { ...PUBLIC_ACCESS, userId: 'bob' },
            { ...PUBLIC_ACCESS, repository: 'octo/other' },
            { ...PUBLIC_ACCESS, sessionId: 'other' },
            { ...PUBLIC_ACCESS, permissions: [] },
        ]) {
            const result = await registry.execute(call('repo_info'), access);
            expect(result.isError).toBe(true);
        }
        expect(calls).toHaveLength(0);
    });

    it('rejects requested repositories that are not the sandbox repository', async () => {
        const { registry, calls, call } = await publicFixture();
        const result = await registry.execute(call('repo_info', { repo: 'octo/other' }), PUBLIC_ACCESS);
        expect(result.isError).toBe(true);
        expect(result.content).toContain('unauthorized');
        expect(calls).toHaveLength(0);
    });

    it('rejects invalid repository identifiers', async () => {
        const { registry, calls, call } = await publicFixture();
        for (const repo of ['../etc/passwd', 'octo/public/extra', 'bad owner/repo']) {
            const result = await registry.execute(call('repo_info', { repo }), PUBLIC_ACCESS);
            expect(result.isError).toBe(true);
            expect(result.content).toContain('invalid-repository');
        }
        const invalidRef = await registry.execute(call('repo_checkout', { ref: '../bad' }), PUBLIC_ACCESS);
        expect(invalidRef.isError).toBe(true);
        expect(invalidRef.content).toContain('invalid-ref');
        expect(calls).toHaveLength(0);
    });

    it('keeps installation tokens out of tool results and sandbox contents', async () => {
        const { registry, sandbox, token } = await privateFixture();
        const result = await registry.execute(
            { id: 'checkout', name: 'repo_checkout', arguments: '{}' },
            PRIVATE_ACCESS,
        );
        expect(result.isError).toBeFalsy();
        expect(result.content).not.toContain(token);
        expect(new TextDecoder().decode(await sandbox.readFile('README.md'))).not.toContain(token);
        expect(sandbox.commands).toEqual([]);
    });
});

describe('AgentRuntime GitHub integration', () => {
    it('exposes read-only repository tools to the model', async () => {
        const { registry, call } = await publicFixture();
        const requests: AgentLLMRequest[] = [];
        const responses: CompletionResult[] = [
            { text: '', toolCalls: [call('repo_info')] },
            { text: 'The repository uses main.' },
        ];
        const runtime = new AgentRuntime(async request => {
            requests.push(request);
            return responses.shift()!;
        });

        const result = await runtime.run([{ role: 'user', content: 'Inspect the repo.' }], registry, {
            access: PUBLIC_ACCESS,
            maxSteps: 4,
        });

        expect(requests[0].tools.map(tool => tool.name)).toEqual(['repo_list', 'repo_info', 'repo_checkout']);
        expect(result.toolResults[0].content).toContain('octo/public');
        expect(result.text).toBe('The repository uses main.');
    });
});
