import type { GitHubService } from '@chatgpt-telegram-workers/agent';
import { MockSandboxClient, createSandboxWorkspace } from '@chatgpt-telegram-workers/sandbox';
import { describe, expect, it, vi } from 'vitest';
import { collectCodingChanges } from './changes';

const BASE = 'a'.repeat(40);
const SESSION = { userId: '10', chatId: '10', repository: 'octo/repo', sessionId: 'session-1' };
const text = (value: string) => new TextEncoder().encode(value);

async function sandbox(files: Record<string, string>) {
    const workspace = await createSandboxWorkspace(SESSION);
    return new MockSandboxClient({ workspace, files });
}

function github(files: Record<string, string>, head = BASE): GitHubService {
    return {
        getBranchHead: vi.fn(async () => ({ ref: 'refs/heads/main', sha: head })),
        downloadRepository: vi.fn(async () => ({
            repository: { owner: 'octo', name: 'repo', fullName: 'octo/repo' },
            ref: 'main',
            commitSha: BASE,
            files: Object.entries(files).map(([path, value]) => ({
                path,
                content: text(value),
                size: text(value).byteLength,
            })),
            totalBytes: Object.values(files).reduce((sum, value) => sum + text(value).byteLength, 0),
            skippedFiles: 0,
        })),
    } as unknown as GitHubService;
}

async function collect(base: Record<string, string>, current: Record<string, string>, head = BASE) {
    const sandboxClient = await sandbox(current);
    return collectCodingChanges({
        session: SESSION,
        baseRef: 'main',
        baseCommitSha: BASE,
        github: github(base, head),
        sandbox: sandboxClient,
        now: () => 1_000,
    });
}

describe('collectCodingChanges', () => {
    it('classifies added, modified, deleted and renamed files', async () => {
        const changeSet = await collect(
            { 'modified.txt': 'old\n', 'deleted.txt': 'gone\n', 'renamed-old.txt': 'same\n' },
            { 'modified.txt': 'new\n', 'added.txt': 'added\n', 'renamed-new.txt': 'same\n' },
        );
        expect(changeSet?.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: 'added.txt', status: 'added', additions: 1 }),
                expect.objectContaining({ path: 'deleted.txt', status: 'deleted', deletions: 1 }),
                expect.objectContaining({ path: 'modified.txt', status: 'modified', additions: 1, deletions: 1 }),
                expect.objectContaining({
                    path: 'renamed-new.txt',
                    previousPath: 'renamed-old.txt',
                    status: 'renamed',
                }),
            ]),
        );
        expect(changeSet?.files).toHaveLength(4);
        expect(changeSet?.diff).toContain('new file mode 100644');
        expect(changeSet?.diff).toContain('deleted file mode 100644');
        expect(changeSet?.diff).toContain('rename from renamed-old.txt');
        expect(changeSet?.diff).toContain('@@ -1 +1 @@');
        expect(changeSet?.summary).toContain('4 files changed');
        expect(changeSet?.summary).toContain('+2 -2');
        expect(changeSet?.diffHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns null when the sandbox has no changes', async () => {
        await expect(collect({ 'same.txt': 'same\n' }, { 'same.txt': 'same\n' })).resolves.toBeNull();
    });

    it('produces a stable diff hash for identical content and metadata', async () => {
        const first = await collect({ 'a.txt': 'old\n' }, { 'a.txt': 'new\n' });
        const second = await collect({ 'a.txt': 'old\n' }, { 'a.txt': 'new\n' });
        expect(first?.diffHash).toBe(second?.diffHash);
        expect(first?.diff).toBe(second?.diff);
    });

    it('marks binary files without rendering their bytes', async () => {
        const workspace = await createSandboxWorkspace(SESSION);
        const sandboxClient = new MockSandboxClient({
            workspace,
            files: { 'image.bin': new Uint8Array([0, 1, 2, 3]) as unknown as string },
        });
        const changeSet = await collectCodingChanges({
            session: SESSION,
            baseRef: 'main',
            baseCommitSha: BASE,
            github: github({ 'image.bin': '' }),
            sandbox: sandboxClient,
        });
        expect(changeSet?.files[0]).toMatchObject({ path: 'image.bin', status: 'modified', binary: true });
        expect(changeSet?.diff).toContain('Binary files differ');
        expect(changeSet?.diff).not.toContain('\u0000');
    });

    it('rejects a base branch that moved after checkout', async () => {
        await expect(collect({ 'a.txt': 'old\n' }, { 'a.txt': 'new\n' }, 'b'.repeat(40))).rejects.toMatchObject({
            code: 'stale',
        });
    });

    it('does not trust the sandbox to stay within the repository', async () => {
        const workspace = await createSandboxWorkspace(SESSION);
        const sandboxClient = new MockSandboxClient({ workspace });
        const git = github({});
        const service = {
            ...git,
            getBranchHead: async () => ({ ref: 'refs/heads/main', sha: BASE }),
        } as unknown as GitHubService;
        await expect(
            collectCodingChanges({
                session: SESSION,
                baseRef: 'main',
                baseCommitSha: BASE,
                github: service,
                sandbox: sandboxClient,
                limits: { maxFiles: 0 },
            }),
        ).resolves.toBeNull();
    });
});
