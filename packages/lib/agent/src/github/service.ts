import type { SandboxClient } from '@chatgpt-telegram-workers/sandbox';
import { DEFAULT_GITHUB_ARCHIVE_LIMITS, extractGitHubArchive, type GitHubArchiveLimits } from './archive';
import type { GitHubAuthorizationProvider } from './authorization';
import type { GitHubTokenProvider } from './auth';
import { GitHubError } from './errors';
import {
    DEFAULT_GITHUB_API_BASE_URL,
    DEFAULT_GITHUB_MAX_JSON_BYTES,
    DEFAULT_GITHUB_TIMEOUT_MS,
    assertAllowedArchiveUrl,
    fetchGitHubResponse,
    mapGitHubHttpError,
    readGitHubResponseBytes,
    readGitHubResponseJson,
} from './http';
import { encodeGitHubRef, normalizeGitHubRef, normalizeGitHubRepository } from './repository';
import type {
    GitHubAccessContext,
    GitHubAuthorizedRepository,
    GitHubCheckoutResult,
    GitHubRepositoryArchive,
    GitHubRepositoryMetadata,
} from './types';

export interface GitHubServiceOptions {
    authorization: GitHubAuthorizationProvider;
    tokenProvider?: GitHubTokenProvider;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
    timeoutMs?: number;
    maxJsonBytes?: number;
    maxArchiveBytes?: number;
    archiveLimits?: Partial<GitHubArchiveLimits>;
}

export interface GitHubServiceRequestOptions {
    signal?: AbortSignal;
}

export interface GitHubDownloadOptions extends GitHubServiceRequestOptions {
    ref?: string;
}

export const DEFAULT_GITHUB_MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new GitHubError('api', 'GitHub returned an invalid repository response');
    }
    return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export class GitHubService {
    private readonly authorization: GitHubAuthorizationProvider;
    private readonly tokenProvider: GitHubTokenProvider | undefined;
    private readonly fetchImpl: typeof fetch | undefined;
    private readonly apiBaseUrl: string;
    private readonly timeoutMs: number;
    private readonly maxJsonBytes: number;
    private readonly maxArchiveBytes: number;
    private readonly archiveLimits: GitHubArchiveLimits;

    constructor(options: GitHubServiceOptions) {
        this.authorization = options.authorization;
        this.tokenProvider = options.tokenProvider;
        this.fetchImpl = options.fetchImpl;
        this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, '');
        let base: URL;
        try {
            base = new URL(this.apiBaseUrl);
        } catch (error) {
            throw new GitHubError('invalid-config', 'GitHub API base URL is invalid', { cause: error });
        }
        if (base.protocol !== 'https:') {
            throw new GitHubError('invalid-config', 'GitHub API base URL must use HTTPS');
        }
        this.timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;
        this.maxJsonBytes = options.maxJsonBytes ?? DEFAULT_GITHUB_MAX_JSON_BYTES;
        this.maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_GITHUB_MAX_ARCHIVE_BYTES;
        this.archiveLimits = { ...DEFAULT_GITHUB_ARCHIVE_LIMITS, ...options.archiveLimits };
    }

    async listAuthorizedRepositories(context: GitHubAccessContext): Promise<GitHubAuthorizedRepository[]> {
        return this.authorization.listAuthorizedRepositories(context);
    }

    async getRepository(
        repositoryInput: string,
        context: GitHubAccessContext,
        options: GitHubServiceRequestOptions = {},
    ): Promise<GitHubRepositoryMetadata> {
        const repository = await this.authorize(repositoryInput, context);
        return this.fetchMetadata(repository, options.signal);
    }

    async downloadRepository(
        repositoryInput: string,
        context: GitHubAccessContext,
        options: GitHubDownloadOptions = {},
    ): Promise<GitHubRepositoryArchive> {
        const repository = await this.authorize(repositoryInput, context);
        const metadata = await this.fetchMetadata(repository, options.signal);
        const ref = normalizeGitHubRef(options.ref ?? metadata.defaultBranch);
        const archive = await this.fetchArchive(repository, ref, options.signal);
        return extractGitHubArchive(archive, repository, ref, this.archiveLimits);
    }

    async checkoutRepository(
        repositoryInput: string,
        context: GitHubAccessContext,
        sandbox: SandboxClient,
        options: GitHubDownloadOptions = {},
    ): Promise<GitHubCheckoutResult> {
        const requested = normalizeGitHubRepository(repositoryInput);
        const workspace = sandbox.workspace;
        if (
            workspace.userId !== context.userId ||
            workspace.repository !== requested.fullName.toLowerCase() ||
            workspace.sessionId !== (context.sessionId ?? 'default')
        ) {
            throw new GitHubError('unauthorized', 'Sandbox workspace does not belong to this user and repository');
        }
        const archive = await this.downloadRepository(repositoryInput, context, options);
        await this.replaceSandboxContents(sandbox, archive, options.signal);
        return {
            repository: archive.repository,
            ref: archive.ref,
            ...(archive.commitSha ? { commitSha: archive.commitSha } : {}),
            filesWritten: archive.files.length,
            bytesWritten: archive.totalBytes,
            skippedFiles: archive.skippedFiles,
        };
    }

    private async authorize(
        repositoryInput: string,
        context: GitHubAccessContext,
    ): Promise<GitHubAuthorizedRepository> {
        const repository = normalizeGitHubRepository(repositoryInput);
        if (context.repository && context.repository.toLowerCase() !== repository.fullName.toLowerCase()) {
            throw new GitHubError('unauthorized', 'Requested repository does not match the access context');
        }
        const authorized = await this.authorization.findAuthorizedRepository(repository, context);
        if (!authorized) {
            throw new GitHubError('unauthorized', 'Repository is not authorized for this user');
        }
        return authorized;
    }

    private async authHeaders(
        repository: GitHubAuthorizedRepository,
        signal: AbortSignal | undefined,
    ): Promise<Record<string, string>> {
        if (!repository.installationId) {
            return {};
        }
        if (!this.tokenProvider) {
            throw new GitHubError('auth', 'GitHub App token provider is not configured');
        }
        const token = await this.tokenProvider.getInstallationToken(repository.installationId, repository, { signal });
        return { authorization: `Bearer ${token.token}` };
    }

    private async requestJson<T>(
        url: string,
        repository: GitHubAuthorizedRepository,
        signal: AbortSignal | undefined,
    ): Promise<T> {
        const response = await fetchGitHubResponse(url, {
            fetchImpl: this.fetchImpl,
            signal,
            timeoutMs: this.timeoutMs,
            headers: await this.authHeaders(repository, signal),
        });
        if (!response.ok) {
            throw mapGitHubHttpError(response);
        }
        return readGitHubResponseJson<T>(response, this.maxJsonBytes, signal, this.timeoutMs);
    }

    private async fetchMetadata(
        repository: GitHubAuthorizedRepository,
        signal: AbortSignal | undefined,
    ): Promise<GitHubRepositoryMetadata> {
        const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
        const raw = asRecord(await this.requestJson<unknown>(url, repository, signal));
        const defaultBranch = typeof raw.default_branch === 'string' ? raw.default_branch : '';
        if (!defaultBranch) {
            throw new GitHubError('api', 'GitHub repository has no default branch');
        }
        return {
            fullName: typeof raw.full_name === 'string' ? raw.full_name : repository.fullName,
            owner: repository.owner,
            name: repository.name,
            private: raw.private === true,
            defaultBranch,
            description: optionalString(raw.description),
            htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : `https://github.com/${repository.fullName}`,
            language: optionalString(raw.language),
            sizeKb: typeof raw.size === 'number' && Number.isFinite(raw.size) ? Math.max(0, raw.size) : 0,
            archived: raw.archived === true,
            ...(typeof raw.updated_at === 'string' ? { updatedAt: raw.updated_at } : {}),
        };
    }

    private async fetchArchive(
        repository: GitHubAuthorizedRepository,
        ref: string,
        signal: AbortSignal | undefined,
    ): Promise<Uint8Array> {
        let url = `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/zipball/${encodeGitHubRef(ref)}`;
        let response = await fetchGitHubResponse(url, {
            fetchImpl: this.fetchImpl,
            signal,
            timeoutMs: this.timeoutMs,
            headers: await this.authHeaders(repository, signal),
        });

        for (let redirects = 0; redirects < 3 && response.status >= 300 && response.status < 400; redirects++) {
            const location = response.headers.get('location');
            await response.body?.cancel().catch(() => {});
            if (!location) {
                throw new GitHubError('api', 'GitHub archive redirect had no location');
            }
            url = assertAllowedArchiveUrl(new URL(location, url).toString(), this.apiBaseUrl);
            response = await fetchGitHubResponse(url, {
                fetchImpl: this.fetchImpl,
                signal,
                timeoutMs: this.timeoutMs,
                headers: { accept: 'application/zip' },
            });
        }

        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => {});
            throw new GitHubError('api', 'Too many GitHub archive redirects');
        }
        if (!response.ok) {
            throw mapGitHubHttpError(response);
        }
        const bytes = await readGitHubResponseBytes(response, this.maxArchiveBytes, signal, this.timeoutMs);
        if (bytes.byteLength === 0) {
            throw new GitHubError('archive', 'GitHub returned an empty repository archive');
        }
        return bytes;
    }

    private async replaceSandboxContents(
        sandbox: SandboxClient,
        archive: GitHubRepositoryArchive,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        let listing;
        try {
            listing = await sandbox.list('', {
                maxEntries: this.archiveLimits.maxFiles + 1,
                signal,
            });
        } catch (error) {
            throw new GitHubError('sandbox', 'Could not inspect the sandbox workspace', { cause: error });
        }
        if (listing.truncated) {
            throw new GitHubError('limit', 'Sandbox workspace has too many entries to replace safely');
        }
        try {
            for (const entry of listing.entries) {
                await sandbox.remove(entry.name, { recursive: true, force: true, signal });
            }
        } catch (error) {
            throw new GitHubError('sandbox', 'Could not clear the sandbox workspace', { cause: error });
        }
        try {
            for (const file of archive.files) {
                await sandbox.writeFile(file.path, file.content, { signal });
            }
        } catch (error) {
            throw new GitHubError('sandbox', 'Could not write repository contents to the sandbox', { cause: error });
        }
    }
}
