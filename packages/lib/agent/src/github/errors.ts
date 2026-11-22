export type GitHubErrorCode =
    | 'invalid-config'
    | 'invalid-repository'
    | 'invalid-ref'
    | 'invalid'
    | 'unauthorized'
    | 'not-found'
    | 'auth'
    | 'rate-limit'
    | 'timeout'
    | 'aborted'
    | 'limit'
    | 'api'
    | 'archive'
    | 'sandbox'
    | 'permission'
    | 'conflict'
    | 'verification';

export class GitHubError extends Error {
    readonly name = 'GitHubError';

    constructor(
        public readonly code: GitHubErrorCode,
        message: string,
        options?: ErrorOptions & { status?: number; retryAfterSeconds?: number },
    ) {
        super(message, options);
        this.status = options?.status;
        this.retryAfterSeconds = options?.retryAfterSeconds;
    }

    readonly status?: number;
    readonly retryAfterSeconds?: number;
}

export function formatGitHubError(error: unknown): string {
    if (error instanceof GitHubError) {
        return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}
