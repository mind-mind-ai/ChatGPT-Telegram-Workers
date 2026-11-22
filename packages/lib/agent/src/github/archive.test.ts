import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GITHUB_ARCHIVE_LIMITS, extractGitHubArchive } from './archive';
import { GitHubError } from './errors';
import { normalizeGitHubRepository } from './repository';

const REPOSITORY = normalizeGitHubRepository('octo/demo');
const ROOT = 'octo-demo-0123456789abcdef';
const text = (value: string) => new TextEncoder().encode(value);

function archive(files: Record<string, string>): Uint8Array {
    return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [`${ROOT}/${path}`, text(value)])));
}

describe('extractGitHubArchive', () => {
    it('strips the GitHub root and returns sorted validated files', () => {
        const result = extractGitHubArchive(archive({ 'src/b.ts': 'b', 'README.md': 'hello' }), REPOSITORY, 'main');

        expect(result.files.map(file => file.path)).toEqual(['README.md', 'src/b.ts']);
        expect(new TextDecoder().decode(result.files[1].content)).toBe('b');
        expect(result.commitSha).toBe('0123456789abcdef');
        expect(result.totalBytes).toBe(6);
    });

    it('rejects path traversal, absolute paths and duplicate normalized paths', () => {
        const cases: Record<string, string>[] = [
            { '../evil.txt': 'evil' },
            { '/etc/passwd': 'evil' },
            { 'src/../../evil.txt': 'evil' },
            { './README.md': 'one', 'README.md': 'two' },
        ];
        for (const files of cases) {
            expect(() => extractGitHubArchive(archive(files), REPOSITORY, 'main')).toThrow(GitHubError);
        }
    });

    it('skips .git metadata and treats it as untrusted data, not executable content', () => {
        const result = extractGitHubArchive(
            archive({ '.git/config': 'token=secret', 'README.md': 'hello' }),
            REPOSITORY,
            'main',
        );
        expect(result.files.map(file => file.path)).toEqual(['README.md']);
        expect(result.skippedFiles).toBe(1);
    });

    it('enforces archive file and expansion limits before writing', () => {
        const bytes = archive({ 'big.bin': 'x'.repeat(100) });
        expect(() =>
            extractGitHubArchive(bytes, REPOSITORY, 'main', {
                ...DEFAULT_GITHUB_ARCHIVE_LIMITS,
                maxFileBytes: 10,
            }),
        ).toThrow(/too large/);

        expect(() =>
            extractGitHubArchive(bytes, REPOSITORY, 'main', {
                ...DEFAULT_GITHUB_ARCHIVE_LIMITS,
                maxExtractedBytes: 10,
            }),
        ).toThrow(/size limit/);

        expect(() =>
            extractGitHubArchive(archive({ 'a.txt': 'a', 'b.txt': 'b' }), REPOSITORY, 'main', {
                ...DEFAULT_GITHUB_ARCHIVE_LIMITS,
                maxFiles: 1,
            }),
        ).toThrow(/too many files/);
    });

    it('rejects invalid archives without exposing their contents', () => {
        expect(() => extractGitHubArchive(text('not a zip'), REPOSITORY, 'main')).toThrow(GitHubError);
    });
});
