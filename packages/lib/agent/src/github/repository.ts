import { GitHubError } from './errors';
import type { GitHubRepositoryRef } from './types';

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const REF_FORBIDDEN = /[\0-\x20\x7f~^:?*[\\]/;

export function normalizeGitHubRepository(value: string): GitHubRepositoryRef {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || trimmed.length > 201) {
        throw new GitHubError('invalid-repository', 'Repository must be in owner/name format');
    }
    const parts = trimmed.split('/');
    if (parts.length !== 2) {
        throw new GitHubError('invalid-repository', 'Repository must be in owner/name format');
    }
    const [owner, name] = parts;
    if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(name) || name === '.' || name === '..') {
        throw new GitHubError('invalid-repository', 'Repository identifier contains invalid characters');
    }
    return { owner, name, fullName: `${owner}/${name}` };
}

export function repositoryKey(repository: GitHubRepositoryRef | string): string {
    return (
        typeof repository === 'string' ? normalizeGitHubRepository(repository).fullName : repository.fullName
    ).toLowerCase();
}

export function normalizeGitHubRef(value: string): string {
    const ref = typeof value === 'string' ? value.trim() : '';
    if (!ref || ref.length > 255 || REF_FORBIDDEN.test(ref) || ref.includes('..')) {
        throw new GitHubError('invalid-ref', 'Invalid git ref');
    }
    const parts = ref.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.lock'))) {
        throw new GitHubError('invalid-ref', 'Invalid git ref');
    }
    return ref;
}

export function encodeGitHubRef(ref: string): string {
    return normalizeGitHubRef(ref).split('/').map(encodeURIComponent).join('/');
}
