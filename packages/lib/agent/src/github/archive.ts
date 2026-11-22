import { unzipSync } from 'fflate';
import { normalizeRelativePath } from '@chatgpt-telegram-workers/sandbox';
import { GitHubError } from './errors';
import type { GitHubRepositoryArchive, GitHubRepositoryFile, GitHubRepositoryRef } from './types';

export interface GitHubArchiveLimits {
    maxExtractedBytes: number;
    maxFiles: number;
    maxFileBytes: number;
    maxPathLength: number;
}

export const DEFAULT_GITHUB_ARCHIVE_LIMITS: GitHubArchiveLimits = {
    maxExtractedBytes: 50 * 1024 * 1024,
    maxFiles: 5_000,
    maxFileBytes: 2 * 1024 * 1024,
    maxPathLength: 512,
};

function commonArchiveRoot(paths: string[]): string {
    const roots = new Set(paths.map(path => path.split('/')[0]));
    if (roots.size !== 1 || paths.some(path => !path.includes('/'))) {
        return '';
    }
    return [...roots][0];
}

function archiveCommitSha(root: string): string | undefined {
    const match = root.match(/-([0-9a-f]{7,40})$/i);
    return match?.[1];
}

/**
 * Extracts a GitHub zipball in memory, validates every path, and never writes
 * symlinks or files outside the sandbox workspace. The limits are enforced
 * before decompression using the ZIP central directory sizes.
 */
export function extractGitHubArchive(
    bytes: Uint8Array,
    repository: GitHubRepositoryRef,
    ref: string,
    limits: GitHubArchiveLimits = DEFAULT_GITHUB_ARCHIVE_LIMITS,
): GitHubRepositoryArchive {
    let fileCount = 0;
    let declaredBytes = 0;
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(bytes, {
            filter: file => {
                if (file.name.endsWith('/')) {
                    return false;
                }
                fileCount++;
                if (fileCount > limits.maxFiles) {
                    throw new GitHubError('limit', 'Repository contains too many files');
                }
                if (file.originalSize > limits.maxFileBytes) {
                    throw new GitHubError('limit', 'Repository contains a file that is too large');
                }
                declaredBytes += file.originalSize;
                if (declaredBytes > limits.maxExtractedBytes) {
                    throw new GitHubError('limit', 'Repository expands beyond the size limit');
                }
                return true;
            },
        });
    } catch (error) {
        if (error instanceof GitHubError) {
            throw error;
        }
        throw new GitHubError('archive', 'Repository archive could not be read', { cause: error });
    }

    const names = Object.keys(entries);
    const root = commonArchiveRoot(names);
    const files: GitHubRepositoryFile[] = [];
    const seen = new Set<string>();
    let skippedFiles = 0;
    let totalBytes = 0;

    for (const name of names) {
        const relative = root ? name.slice(root.length + 1) : name;
        if (!relative || relative === '.git' || relative.startsWith('.git/')) {
            skippedFiles++;
            continue;
        }
        if (relative.includes('\\') || relative.length > limits.maxPathLength) {
            throw new GitHubError('archive', 'Repository archive contains an unsafe path');
        }
        let path: string;
        try {
            path = normalizeRelativePath(relative, 'repository path');
        } catch (error) {
            throw new GitHubError('archive', 'Repository archive contains an unsafe path', { cause: error });
        }
        if (!path || seen.has(path)) {
            throw new GitHubError('archive', 'Repository archive contains duplicate paths');
        }
        const content = entries[name];
        if (content.byteLength > limits.maxFileBytes) {
            throw new GitHubError('limit', 'Repository contains a file that is too large');
        }
        totalBytes += content.byteLength;
        if (totalBytes > limits.maxExtractedBytes) {
            throw new GitHubError('limit', 'Repository expands beyond the size limit');
        }
        seen.add(path);
        files.push({ path, content: new Uint8Array(content), size: content.byteLength });
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
        repository,
        ref,
        ...(root && archiveCommitSha(root) ? { commitSha: archiveCommitSha(root) } : {}),
        files,
        totalBytes,
        skippedFiles,
    };
}
