import { describe, expect, it, vi } from 'vitest';
import { StaticGitHubAuthorizationProvider } from './authorization';
import type { GitHubTokenProvider } from './auth';
import { GitHubService } from './service';
import type { GitHubAccessContext, GitHubWriteChangesInput } from './types';

const ACCESS: GitHubAccessContext = { userId: 'alice', repository: 'octo/public', sessionId: 's1' };
const BASE = 'a'.repeat(40);
const BASE_TREE = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const NEW_TREE = 'd'.repeat(40);
const COMMIT = 'e'.repeat(40);
const TOKEN = 'ghs_write_secret';

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function writeInput(overrides: Partial<GitHubWriteChangesInput> = {}): GitHubWriteChangesInput {
    return {
        baseRef: 'main',
        expectedBaseSha: BASE,
        branchName: 'telegram-agent/session-1',
        message: 'Telegram approved change',
        changes: [
            {
                path: 'src/a.ts',
                status: 'modified',
                contentBase64: btoa('new\n'),
                sha256: '7aa7a5359173d05b63cfd682e3c38487f3cb4f7f1d60659fe59fab1505977d4c',
            },
        ],
        ...overrides,
    };
}

function fakeGitHub(
    overrides: { branchInitially?: string | null; patchStatus?: number; patchAlwaysFail?: boolean } = {},
) {
    let branchSha = overrides.branchInitially === undefined ? null : overrides.branchInitially;
    let patchAttempts = 0;
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? 'GET';
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        calls.push({ url, method, headers, ...(typeof init.body === 'string' ? { body: init.body } : {}) });
        if (method === 'GET' && url.endsWith('/repos/octo/public')) {
            return json({ full_name: 'octo/public', private: false, default_branch: 'main', size: 1 });
        }
        if (method === 'GET' && url.includes('/git/ref/heads/main')) {
            return json({ ref: 'refs/heads/main', object: { sha: BASE, type: 'commit' } });
        }
        if (method === 'GET' && url.includes(`/git/commits/${BASE}`)) {
            return json({ sha: BASE, tree: { sha: BASE_TREE }, parents: [] });
        }
        if (method === 'GET' && url.includes(`/git/commits/${COMMIT}`)) {
            return json({ sha: COMMIT, tree: { sha: NEW_TREE }, parents: [{ sha: BASE }] });
        }
        if (method === 'GET' && url.includes('/git/ref/heads/telegram-agent/')) {
            return branchSha
                ? json({ ref: 'refs/heads/telegram-agent/session-1', object: { sha: branchSha, type: 'commit' } })
                : json({ message: 'Not Found' }, 404);
        }
        if (method === 'POST' && url.endsWith('/git/blobs')) {
            return json({ sha: BLOB }, 201);
        }
        if (method === 'POST' && url.endsWith('/git/trees')) {
            return json({ sha: NEW_TREE }, 201);
        }
        if (method === 'POST' && url.endsWith('/git/refs')) {
            branchSha = BASE;
            return json({ ref: 'refs/heads/telegram-agent/session-1', object: { sha: BASE } }, 201);
        }
        if (method === 'POST' && url.endsWith('/git/commits')) {
            return json({ sha: COMMIT }, 201);
        }
        if (method === 'PATCH' && url.includes('/git/refs/heads/telegram-agent/')) {
            patchAttempts += 1;
            branchSha = COMMIT;
            if (overrides.patchAlwaysFail) {
                return json({ message: 'temporary failure' }, 500);
            }
            if (overrides.patchStatus && patchAttempts === 1) {
                return json({ message: 'temporary failure' }, overrides.patchStatus);
            }
            return json({ ref: 'refs/heads/telegram-agent/session-1', object: { sha: COMMIT } });
        }
        return json({ message: 'Not Found' }, 404);
    }) as typeof fetch;
    return { fetchImpl, calls, branch: () => branchSha };
}

function service(
    fetchImpl: typeof fetch,
    options: {
        writeRepositories?: string[];
        writeTokenProvider?: GitHubTokenProvider;
        omitWriteTokenProvider?: boolean;
    } = {},
) {
    const tokenProvider: GitHubTokenProvider = {
        getInstallationToken: vi.fn(async () => ({ token: TOKEN, expiresAt: Date.now() + 3_600_000 })),
    };
    return new GitHubService({
        authorization: new StaticGitHubAuthorizationProvider({
            repositories: ['octo/public'],
            installationId: '123',
        }),
        tokenProvider,
        ...(options.omitWriteTokenProvider ? {} : { writeTokenProvider: options.writeTokenProvider ?? tokenProvider }),
        writeRepositories: options.writeRepositories ?? ['octo/public'],
        fetchImpl,
        apiBaseUrl: 'https://api.github.test',
    });
}

describe('GitHubService writeChanges', () => {
    it('creates blobs, a tree, a commit and a non-default branch, then verifies the result', async () => {
        const fake = fakeGitHub();
        const result = await service(fake.fetchImpl).writeChanges('octo/public', ACCESS, writeInput());

        expect(result).toMatchObject({
            branch: 'telegram-agent/session-1',
            commitSha: COMMIT,
            baseSha: BASE,
            filesChanged: 1,
        });
        const writes = fake.calls.filter(call => call.method !== 'GET');
        expect(writes.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
            'POST /repos/octo/public/git/blobs',
            'POST /repos/octo/public/git/trees',
            'POST /repos/octo/public/git/refs',
            'POST /repos/octo/public/git/commits',
            'PATCH /repos/octo/public/git/refs/heads/telegram-agent/session-1',
        ]);
        expect(JSON.parse(writes[1].body!)).toMatchObject({
            base_tree: BASE_TREE,
            tree: [{ path: 'src/a.ts', mode: '100644', type: 'blob', sha: BLOB }],
        });
        expect(writes.every(call => call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
        expect(JSON.stringify(result)).not.toContain(TOKEN);
        expect(fake.branch()).toBe(COMMIT);
    });

    it('encodes added, modified, deleted and renamed files correctly', async () => {
        const fake = fakeGitHub();
        const changes: GitHubWriteChangesInput['changes'] = [
            { path: 'added.txt', status: 'added', contentBase64: btoa('add\n'), sha256: '1'.repeat(64) },
            { path: 'modified.txt', status: 'modified', contentBase64: btoa('mod\n'), sha256: '2'.repeat(64) },
            { path: 'deleted.txt', status: 'deleted', sha256: '3'.repeat(64) },
            {
                path: 'renamed-new.txt',
                previousPath: 'renamed-old.txt',
                status: 'renamed',
                contentBase64: btoa('same\n'),
                sha256: '4'.repeat(64),
            },
        ];
        // Use the matching hashes for the provided content.
        const actualHash = async (value: string) =>
            [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('');
        changes[0].sha256 = await actualHash('add\n');
        changes[1].sha256 = await actualHash('mod\n');
        changes[3].sha256 = await actualHash('same\n');

        await service(fake.fetchImpl).writeChanges('octo/public', ACCESS, writeInput({ changes }));
        const treeCall = fake.calls.find(call => call.method === 'POST' && call.url.endsWith('/git/trees'))!;
        expect(JSON.parse(treeCall.body!).tree).toEqual([
            { path: 'added.txt', mode: '100644', type: 'blob', sha: BLOB },
            { path: 'modified.txt', mode: '100644', type: 'blob', sha: BLOB },
            { path: 'deleted.txt', mode: '100644', type: 'blob', sha: null },
            { path: 'renamed-old.txt', mode: '100644', type: 'blob', sha: null },
            { path: 'renamed-new.txt', mode: '100644', type: 'blob', sha: BLOB },
        ]);
    });

    it('refuses to write without an explicit write allowlist entry', async () => {
        const fake = fakeGitHub();
        await expect(
            service(fake.fetchImpl, { writeRepositories: [] }).writeChanges('octo/public', ACCESS, writeInput()),
        ).rejects.toMatchObject({ code: 'permission' });
        expect(fake.calls).toHaveLength(0);
    });

    it('refuses to write without a write token provider', async () => {
        const fake = fakeGitHub();
        await expect(
            service(fake.fetchImpl, { omitWriteTokenProvider: true }).writeChanges('octo/public', ACCESS, writeInput()),
        ).rejects.toMatchObject({ code: 'permission' });
    });

    it('refuses to write directly to the default or base branch', async () => {
        const fake = fakeGitHub();
        await expect(
            service(fake.fetchImpl).writeChanges('octo/public', ACCESS, writeInput({ branchName: 'main' })),
        ).rejects.toMatchObject({ code: 'permission' });
        expect(fake.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    });

    it('detects a moved base branch before writing', async () => {
        const fake = fakeGitHub();
        await expect(
            service(fake.fetchImpl).writeChanges(
                'octo/public',
                ACCESS,
                writeInput({ expectedBaseSha: 'f'.repeat(40) }),
            ),
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(fake.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    });

    it('does not overwrite an existing unrelated target branch', async () => {
        const fake = fakeGitHub({ branchInitially: 'f'.repeat(40) });
        await expect(service(fake.fetchImpl).writeChanges('octo/public', ACCESS, writeInput())).rejects.toMatchObject({
            code: 'conflict',
        });
        expect(fake.calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
    });

    it('recovers safely when a ref update response is lost after the commit landed', async () => {
        const fake = fakeGitHub({ patchStatus: 500 });
        const result = await service(fake.fetchImpl).writeChanges('octo/public', ACCESS, writeInput());
        expect(result.commitSha).toBe(COMMIT);
        expect(fake.branch()).toBe(COMMIT);
    });

    it('recovers when every ref update response is lost after the commit landed', async () => {
        const fake = fakeGitHub({ patchAlwaysFail: true });
        const result = await service(fake.fetchImpl).writeChanges('octo/public', ACCESS, writeInput());
        expect(result.commitSha).toBe(COMMIT);
        expect(fake.branch()).toBe(COMMIT);
    });

    it('rejects an invalid approved base SHA before writing', async () => {
        const fake = fakeGitHub();
        await expect(
            service(fake.fetchImpl).writeChanges('octo/public', ACCESS, writeInput({ expectedBaseSha: 'not-a-sha' })),
        ).rejects.toMatchObject({ code: 'invalid' });
        expect(fake.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    });

    it('rejects unsafe paths and content hash mismatches before writing', async () => {
        const fake = fakeGitHub();
        await expect(
            service(fake.fetchImpl).writeChanges(
                'octo/public',
                ACCESS,
                writeInput({
                    changes: [
                        {
                            path: '../escape.ts',
                            status: 'added',
                            contentBase64: btoa('x'),
                        },
                    ],
                }),
            ),
        ).rejects.toMatchObject({ code: 'invalid' });
        await expect(
            service(fake.fetchImpl).writeChanges(
                'octo/public',
                ACCESS,
                writeInput({
                    changes: [
                        {
                            path: 'src/a.ts',
                            status: 'modified',
                            contentBase64: btoa('new\n'),
                            sha256: '0'.repeat(64),
                        },
                    ],
                }),
            ),
        ).rejects.toMatchObject({ code: 'invalid' });
        expect(fake.calls.filter(call => call.method === 'POST' && call.url.endsWith('/git/blobs'))).toHaveLength(0);
    });
});
