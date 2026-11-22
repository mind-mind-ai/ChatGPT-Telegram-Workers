import { describe, expect, it } from 'vitest';
import { SandboxError } from './errors';
import { createSandboxWorkspace, normalizeSandboxScope } from './workspace';

describe('sandbox workspace identity', () => {
    it('derives a stable, user- and repository-specific name', async () => {
        const first = await createSandboxWorkspace({
            userId: '123',
            repository: 'Owner/Repo',
            sessionId: 'task-1',
        });
        const second = await createSandboxWorkspace({
            userId: '123',
            repository: 'owner/repo',
            sessionId: 'task-1',
        });
        const otherUser = await createSandboxWorkspace({
            userId: '456',
            repository: 'owner/repo',
            sessionId: 'task-1',
        });
        const otherRepository = await createSandboxWorkspace({
            userId: '123',
            repository: 'owner/other',
            sessionId: 'task-1',
        });

        expect(first).toEqual(second);
        expect(first.name).toBe(`sandbox-${first.id}`);
        expect(first.name).not.toBe(otherUser.name);
        expect(first.name).not.toBe(otherRepository.name);
        expect(first.repository).toBe('owner/repo');
        expect(first.rootDir).toBe('/workspace');
    });

    it('rejects invalid scopes', () => {
        expect(() => normalizeSandboxScope({ userId: '', repository: 'owner/repo' })).toThrow(SandboxError);
        expect(() => normalizeSandboxScope({ userId: '123', repository: 'not-a-repo' })).toThrow(SandboxError);
        expect(() =>
            normalizeSandboxScope({ userId: '123', repository: 'owner/repo', sessionId: 'bad session' }),
        ).toThrow(SandboxError);
    });

    it('accepts a scoped workspace root', async () => {
        const workspace = await createSandboxWorkspace(
            { userId: '123', repository: 'owner/repo' },
            '/workspace/repositories/owner/repo',
        );
        expect(workspace.rootDir).toBe('/workspace/repositories/owner/repo');
    });
});
