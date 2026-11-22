import { describe, expect, it } from 'vitest';
import { createGitHubServiceFromEnv } from './config';
import { GitHubError } from './errors';

describe('createGitHubServiceFromEnv', () => {
    it('parses a global repository allowlist', async () => {
        const service = createGitHubServiceFromEnv({
            GITHUB_ALLOWED_REPOSITORIES: 'octo/public, octo/other',
        });
        const repositories = await service.listAuthorizedRepositories({ userId: 'alice' });
        expect(repositories.map(repository => repository.fullName)).toEqual(['octo/other', 'octo/public']);
    });

    it('supports per-user allowlists and installation overrides', async () => {
        const service = createGitHubServiceFromEnv({
            GITHUB_ALLOWED_REPOSITORIES_BY_USER: JSON.stringify({
                alice: ['octo/private'],
                bob: 'octo/bob',
            }),
            GITHUB_INSTALLATION_ID: '100',
            GITHUB_INSTALLATION_IDS: JSON.stringify({ 'octo/private': '200' }),
        });

        const alice = await service.listAuthorizedRepositories({ userId: 'alice' });
        expect(alice).toEqual([expect.objectContaining({ fullName: 'octo/private', installationId: '200' })]);
        const bob = await service.listAuthorizedRepositories({ userId: 'bob' });
        expect(bob).toEqual([expect.objectContaining({ fullName: 'octo/bob', installationId: '100' })]);
    });

    it('keeps the write allowlist separate from the read allowlist', async () => {
        const service = createGitHubServiceFromEnv({
            GITHUB_ALLOWED_REPOSITORIES: 'octo/public',
            GITHUB_WRITE_ALLOWED_REPOSITORIES: 'octo/private',
        });
        const repositories = await service.listAuthorizedRepositories({ userId: 'alice' });
        expect(repositories.map(repository => repository.fullName)).toEqual(['octo/public']);
        await expect(
            service.writeChanges(
                'octo/public',
                { userId: 'alice' },
                {
                    baseRef: 'main',
                    expectedBaseSha: 'a'.repeat(40),
                    branchName: 'telegram-agent/test',
                    message: 'test',
                    changes: [{ path: 'a.txt', status: 'added', contentBase64: 'eA==' }],
                },
            ),
        ).rejects.toMatchObject({ code: 'permission' });
    });

    it('rejects invalid configuration without requiring real credentials', () => {
        expect(() => createGitHubServiceFromEnv({ GITHUB_ALLOWED_REPOSITORIES_BY_USER: 'not-json' })).toThrow(
            GitHubError,
        );
        expect(() =>
            createGitHubServiceFromEnv({
                GITHUB_ALLOWED_REPOSITORIES: 'octo/public',
                GITHUB_APP_ID: '123',
            }),
        ).toThrow(GitHubError);
        expect(() =>
            createGitHubServiceFromEnv({
                GITHUB_ALLOWED_REPOSITORIES: 'octo/public',
                GITHUB_INSTALLATION_ID: '../bad',
            }),
        ).toThrow(GitHubError);
    });
});
