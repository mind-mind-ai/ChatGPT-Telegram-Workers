import { normalizeSandboxScope, type SandboxScope, type SandboxWorkspace } from '@chatgpt-telegram-workers/sandbox';
import type { ToolAccessContext } from '../tools';

function metadataString(context: ToolAccessContext, key: string): string | undefined {
    const value = context.metadata?.[key];
    return typeof value === 'string' ? value : undefined;
}

/**
 * Reads the sandbox scope from the caller identity. Explicit fields win over
 * metadata so callers can migrate without weakening the ownership check.
 */
export function codingScope(context: ToolAccessContext): SandboxScope {
    const userId = context.userId ?? metadataString(context, 'userId');
    const repository = context.repository ?? metadataString(context, 'repository');
    if (!userId) {
        throw new Error('userId is required for coding tools');
    }
    if (!repository) {
        throw new Error('repository is required for coding tools');
    }
    return normalizeSandboxScope({
        userId,
        repository,
        sessionId: context.sessionId ?? metadataString(context, 'sessionId'),
    });
}

/** Returns a safe denial reason, or null when the caller owns the workspace. */
export function ownershipError(workspace: SandboxWorkspace, context: ToolAccessContext): string | null {
    let scope: Required<SandboxScope>;
    try {
        scope = normalizeSandboxScope(codingScope(context));
    } catch (error) {
        return error instanceof Error ? error.message : 'invalid sandbox scope';
    }

    if (
        scope.userId !== workspace.userId ||
        scope.repository !== workspace.repository ||
        scope.sessionId !== workspace.sessionId
    ) {
        return 'sandbox workspace does not belong to this user, repository and session';
    }
    return null;
}
