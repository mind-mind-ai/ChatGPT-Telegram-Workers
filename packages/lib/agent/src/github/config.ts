import { StaticGitHubAuthorizationProvider } from './authorization';
import { GitHubAppTokenProvider } from './auth';
import { GitHubError } from './errors';
import { DEFAULT_GITHUB_API_BASE_URL, DEFAULT_GITHUB_TIMEOUT_MS } from './http';
import { normalizeGitHubRepository } from './repository';
import { GitHubService } from './service';

export interface GitHubEnvironment {
    GITHUB_APP_ID?: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    GITHUB_INSTALLATION_ID?: string;
    GITHUB_ALLOWED_REPOSITORIES?: string;
    GITHUB_ALLOWED_REPOSITORIES_BY_USER?: string;
    GITHUB_INSTALLATION_IDS?: string;
    GITHUB_API_BASE_URL?: string;
}

export interface GitHubServiceFromEnvOptions {
    fetchImpl?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
}

function parseRepositoryList(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function parseJsonObject(value: string | undefined, name: string): Record<string, unknown> | undefined {
    if (!value?.trim()) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        throw new GitHubError('invalid-config', `${name} must be valid JSON`, { cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new GitHubError('invalid-config', `${name} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
}

function parseUserRepositories(value: string | undefined): Record<string, string[]> | undefined {
    const parsed = parseJsonObject(value, 'GITHUB_ALLOWED_REPOSITORIES_BY_USER');
    if (!parsed) {
        return undefined;
    }
    const result: Record<string, string[]> = {};
    for (const [user, repositories] of Object.entries(parsed)) {
        if (!user.trim()) {
            throw new GitHubError('invalid-config', 'GitHub authorization user key must not be empty');
        }
        if (typeof repositories === 'string') {
            result[user] = parseRepositoryList(repositories);
            continue;
        }
        if (!Array.isArray(repositories) || repositories.some(item => typeof item !== 'string')) {
            throw new GitHubError('invalid-config', 'GitHub user repository allowlist must be a string array');
        }
        result[user] = repositories as string[];
    }
    return result;
}

function parseInstallationIds(value: string | undefined): Record<string, string> | undefined {
    const parsed = parseJsonObject(value, 'GITHUB_INSTALLATION_IDS');
    if (!parsed) {
        return undefined;
    }
    const result: Record<string, string> = {};
    for (const [repository, installationId] of Object.entries(parsed)) {
        normalizeGitHubRepository(repository);
        if (typeof installationId !== 'string' || !/^\d{1,20}$/.test(installationId.trim())) {
            throw new GitHubError('invalid-config', 'GitHub installation ids must be numeric strings');
        }
        result[repository] = installationId.trim();
    }
    return result;
}

/** Builds a read-only GitHub service from operator-provided environment values. */
export function createGitHubServiceFromEnv(
    env: GitHubEnvironment,
    options: GitHubServiceFromEnvOptions = {},
): GitHubService {
    const globalRepositories = parseRepositoryList(env.GITHUB_ALLOWED_REPOSITORIES);
    const userRepositories = parseUserRepositories(env.GITHUB_ALLOWED_REPOSITORIES_BY_USER);
    const repositories = userRepositories
        ? { ...(globalRepositories.length ? { '*': globalRepositories } : {}), ...userRepositories }
        : globalRepositories;
    const authorization = new StaticGitHubAuthorizationProvider({
        repositories,
        installationId: env.GITHUB_INSTALLATION_ID,
        installationIds: parseInstallationIds(env.GITHUB_INSTALLATION_IDS),
    });

    const appId = env.GITHUB_APP_ID?.trim();
    const privateKey = env.GITHUB_APP_PRIVATE_KEY;
    if (Boolean(appId) !== Boolean(privateKey)) {
        throw new GitHubError('invalid-config', 'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set together');
    }
    const tokenProvider =
        appId && privateKey
            ? new GitHubAppTokenProvider({
                  appId,
                  privateKey,
                  fetchImpl: options.fetchImpl,
                  apiBaseUrl: env.GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API_BASE_URL,
                  timeoutMs: options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS,
                  ...(options.now ? { now: options.now } : {}),
              })
            : undefined;

    return new GitHubService({
        authorization,
        ...(tokenProvider ? { tokenProvider } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(env.GITHUB_API_BASE_URL ? { apiBaseUrl: env.GITHUB_API_BASE_URL } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
}
