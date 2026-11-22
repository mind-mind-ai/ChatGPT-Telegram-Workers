import { SandboxPathError } from './errors';

/** Validates an absolute workspace root such as `/workspace/repo`. */
export function normalizeRootDir(rootDir: string): string {
    if (typeof rootDir !== 'string' || rootDir.length === 0 || rootDir.includes('\0')) {
        throw new SandboxPathError('Workspace root must be a non-empty absolute path');
    }
    if (!rootDir.startsWith('/')) {
        throw new SandboxPathError('Workspace root must be absolute');
    }
    const parts = rootDir.split('/').filter(part => part !== '' && part !== '.');
    if (parts.length === 0 || parts.some(part => part === '..')) {
        throw new SandboxPathError('Workspace root must not contain ".." and must not be "/"');
    }
    return `/${parts.join('/')}`;
}

/**
 * Normalizes a path relative to the workspace root. Absolute paths and `..`
 * segments are rejected so a tool cannot escape the per-user workspace.
 */
export function normalizeRelativePath(value: string, label = 'path'): string {
    if (typeof value !== 'string' || value.includes('\0')) {
        throw new SandboxPathError(`${label} must be a string without NUL characters`);
    }
    if (value.startsWith('/')) {
        throw new SandboxPathError(`${label} must be relative to the workspace`);
    }
    const parts = value.split('/').filter(part => part !== '' && part !== '.');
    if (parts.some(part => part === '..')) {
        throw new SandboxPathError(`${label} must not contain ".."`);
    }
    return parts.join('/');
}

export function resolveSandboxPath(rootDir: string, relativePath = ''): string {
    const root = normalizeRootDir(rootDir);
    const relative = normalizeRelativePath(relativePath);
    return relative ? `${root}/${relative}` : root;
}

export function parentSandboxPath(path: string): string {
    const normalized = normalizeRelativePath(path);
    const index = normalized.lastIndexOf('/');
    return index < 0 ? '' : normalized.slice(0, index);
}
