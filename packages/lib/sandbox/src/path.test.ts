import { describe, expect, it } from 'vitest';
import { SandboxPathError } from './errors';
import { normalizeRelativePath, normalizeRootDir, parentSandboxPath, resolveSandboxPath } from './path';

describe('sandbox paths', () => {
    it('normalizes relative paths', () => {
        expect(normalizeRelativePath('')).toBe('');
        expect(normalizeRelativePath('./src//app.ts')).toBe('src/app.ts');
        expect(resolveSandboxPath('/workspace/repo', 'src/app.ts')).toBe('/workspace/repo/src/app.ts');
        expect(resolveSandboxPath('/workspace/repo', '')).toBe('/workspace/repo');
        expect(parentSandboxPath('src/app.ts')).toBe('src');
        expect(parentSandboxPath('app.ts')).toBe('');
    });

    it('rejects absolute paths, traversal, and NUL characters', () => {
        expect(() => normalizeRelativePath('/etc/passwd')).toThrow(SandboxPathError);
        expect(() => normalizeRelativePath('../secrets')).toThrow(SandboxPathError);
        expect(() => normalizeRelativePath('src/../../secrets')).toThrow(SandboxPathError);
        expect(() => normalizeRelativePath('src/\0app.ts')).toThrow(SandboxPathError);
        expect(() => normalizeRootDir('/')).toThrow(SandboxPathError);
        expect(() => normalizeRootDir('workspace')).toThrow(SandboxPathError);
    });
});
