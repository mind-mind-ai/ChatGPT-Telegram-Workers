import { GitHubError } from './errors';
import { normalizeGitHubRepository, repositoryKey } from './repository';
import type { GitHubAccessContext, GitHubAuthorizedRepository, GitHubRepositoryRef } from './types';

export interface GitHubAuthorizationProvider {
    listAuthorizedRepositories(context: GitHubAccessContext): Promise<GitHubAuthorizedRepository[]>;
    findAuthorizedRepository(
        repository: GitHubRepositoryRef,
        context: GitHubAccessContext,
    ): Promise<GitHubAuthorizedRepository | null>;
}

export interface StaticGitHubAuthorizationOptions {
    /** A global allowlist, or a map of user id to that user's allowlist. `*` is global. */
    repositories: readonly string[] | Readonly<Record<string, readonly string[]>>;
    installationId?: string;
    /** Optional per-repository installation id overrides, keyed by owner/name. */
    installationIds?: Readonly<Record<string, string>>;
}

function normalizeRepositoryList(values: readonly string[]): GitHubAuthorizedRepository[] {
    const result = new Map<string, GitHubAuthorizedRepository>();
    for (const value of values) {
        const repository = normalizeGitHubRepository(value);
        result.set(repositoryKey(repository), repository);
    }
    return [...result.values()];
}

function parseInstallationId(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    if (!/^\d{1,20}$/.test(trimmed)) {
        throw new GitHubError('invalid-config', 'GitHub installation id must be numeric');
    }
    return trimmed;
}

/** Explicit operator-maintained repository authorization. */
export class StaticGitHubAuthorizationProvider implements GitHubAuthorizationProvider {
    private readonly byUser = new Map<string, GitHubAuthorizedRepository[]>();
    private readonly installationId: string | undefined;
    private readonly installationIds = new Map<string, string>();

    constructor(options: StaticGitHubAuthorizationOptions) {
        this.installationId = parseInstallationId(options.installationId);
        for (const [repository, installationId] of Object.entries(options.installationIds ?? {})) {
            const normalized = normalizeGitHubRepository(repository);
            this.installationIds.set(repositoryKey(normalized), parseInstallationId(installationId)!);
        }

        if (Array.isArray(options.repositories)) {
            this.byUser.set('*', normalizeRepositoryList(options.repositories));
        } else {
            for (const [user, repositories] of Object.entries(options.repositories)) {
                if (!user.trim()) {
                    throw new GitHubError('invalid-config', 'GitHub authorization user key must not be empty');
                }
                this.byUser.set(user, normalizeRepositoryList(repositories));
            }
        }
    }

    async listAuthorizedRepositories(context: GitHubAccessContext): Promise<GitHubAuthorizedRepository[]> {
        const repositories = new Map<string, GitHubAuthorizedRepository>();
        for (const repository of this.byUser.get('*') ?? []) {
            repositories.set(repositoryKey(repository), repository);
        }
        for (const repository of this.byUser.get(context.userId) ?? []) {
            repositories.set(repositoryKey(repository), repository);
        }
        return [...repositories.values()]
            .map(repository => this.withInstallationId(repository))
            .sort((a, b) => a.fullName.localeCompare(b.fullName));
    }

    async findAuthorizedRepository(
        repository: GitHubRepositoryRef,
        context: GitHubAccessContext,
    ): Promise<GitHubAuthorizedRepository | null> {
        const key = repositoryKey(repository);
        const allowed =
            (this.byUser.get(context.userId) ?? []).find(candidate => repositoryKey(candidate) === key) ??
            (this.byUser.get('*') ?? []).find(candidate => repositoryKey(candidate) === key);
        return allowed ? this.withInstallationId(allowed) : null;
    }

    private withInstallationId(repository: GitHubAuthorizedRepository): GitHubAuthorizedRepository {
        const installationId = this.installationIds.get(repositoryKey(repository)) ?? this.installationId;
        return installationId ? { ...repository, installationId } : { ...repository };
    }
}
