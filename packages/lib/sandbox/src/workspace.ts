import { SandboxError } from './errors';
import { DEFAULT_WORKSPACE_ROOT } from './limits';
import { normalizeRootDir } from './path';
import type { SandboxScope, SandboxWorkspace } from './types';

const USER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

function requireMatch(value: string | undefined, pattern: RegExp, label: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed || !pattern.test(trimmed)) {
        throw new SandboxError('invalid-workspace', `${label} is invalid`);
    }
    return trimmed;
}

export function normalizeSandboxScope(scope: SandboxScope): Required<SandboxScope> {
    if (!scope || typeof scope !== 'object') {
        throw new SandboxError('invalid-workspace', 'Sandbox scope is required');
    }
    const userId = requireMatch(scope.userId, USER_ID_PATTERN, 'userId');
    const repository = requireMatch(scope.repository, REPOSITORY_PATTERN, 'repository').toLowerCase();
    const sessionId = requireMatch(scope.sessionId ?? 'default', SESSION_ID_PATTERN, 'sessionId');
    return { userId, repository, sessionId };
}

async function sha256Hex(value: string): Promise<string> {
    if (!globalThis.crypto?.subtle) {
        throw new SandboxError('unsupported', 'Web Crypto SHA-256 is not available');
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds a provider-neutral identity for one user's repository session.
 * The hash keeps raw Telegram ids out of Durable Object names and prevents
 * two users or repositories from accidentally sharing a sandbox.
 */
export async function createSandboxWorkspace(
    scope: SandboxScope,
    rootDir = DEFAULT_WORKSPACE_ROOT,
): Promise<SandboxWorkspace> {
    const normalized = normalizeSandboxScope(scope);
    const id = (await sha256Hex(`${normalized.userId}\0${normalized.repository}\0${normalized.sessionId}`)).slice(
        0,
        40,
    );
    return {
        ...normalized,
        id,
        name: `sandbox-${id}`,
        rootDir: normalizeRootDir(rootDir),
    };
}
