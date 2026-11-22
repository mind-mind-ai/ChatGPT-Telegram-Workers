import { normalizeRelativePath, type SandboxClient } from '@chatgpt-telegram-workers/sandbox';
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
import { encodeGitHubRef, normalizeGitHubRef, normalizeGitHubRepository, repositoryKey } from './repository';
import type {
    GitHubAccessContext,
    GitHubAuthorizedRepository,
    GitHubCheckoutResult,
    GitHubBranchHead,
    GitHubCommitInfo,
    GitHubFileChangeInput,
    GitHubRepositoryArchive,
    GitHubRepositoryMetadata,
    GitHubWriteChangesInput,
    GitHubWriteChangesResult,
} from './types';

export interface GitHubServiceOptions {
    authorization: GitHubAuthorizationProvider;
    tokenProvider?: GitHubTokenProvider;
    /** Separate provider that requests Contents: write. Never used for reads. */
    writeTokenProvider?: GitHubTokenProvider;
    /** Explicit repositories where writes are enabled. Empty by default. */
    writeRepositories?: readonly string[];
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

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_WRITE_BASE64_CHARS = 24 * 1024 * 1024;

function assertSha(value: string): void {
    if (!SHA_PATTERN.test(value)) {
        throw new GitHubError('api', 'GitHub returned an invalid commit or tree SHA');
    }
}

function normalizeWritePath(value: string): string {
    let path: string;
    try {
        path = normalizeRelativePath(value, 'change path');
    } catch (error) {
        throw new GitHubError('invalid', 'Change set contains an unsafe path', { cause: error });
    }
    if (!path || path === '.git' || path.startsWith('.git/')) {
        throw new GitHubError('invalid', 'Change set must not modify Git metadata');
    }
    return path;
}

function decodeBase64(value: string): Uint8Array {
    try {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    } catch (error) {
        throw new GitHubError('invalid', 'Change set contains invalid base64 content', { cause: error });
    }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

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
    private readonly writeTokenProvider: GitHubTokenProvider | undefined;
    private readonly writeRepositories: ReadonlySet<string>;
    private readonly fetchImpl: typeof fetch | undefined;
    private readonly apiBaseUrl: string;
    private readonly timeoutMs: number;
    private readonly maxJsonBytes: number;
    private readonly maxArchiveBytes: number;
    private readonly archiveLimits: GitHubArchiveLimits;

    constructor(options: GitHubServiceOptions) {
        this.authorization = options.authorization;
        this.tokenProvider = options.tokenProvider;
        this.writeTokenProvider = options.writeTokenProvider;
        this.writeRepositories = new Set(
            (options.writeRepositories ?? []).map(value => repositoryKey(normalizeGitHubRepository(value))),
        );
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

    async getBranchHead(
        repositoryInput: string,
        context: GitHubAccessContext,
        ref: string,
        options: GitHubServiceRequestOptions = {},
    ): Promise<GitHubBranchHead> {
        const repository = await this.authorize(repositoryInput, context);
        return this.fetchBranchHead(repository, normalizeGitHubRef(ref), options.signal);
    }

    async getCommit(
        repositoryInput: string,
        context: GitHubAccessContext,
        sha: string,
        options: GitHubServiceRequestOptions = {},
    ): Promise<GitHubCommitInfo> {
        const repository = await this.authorize(repositoryInput, context);
        return this.fetchCommit(repository, sha, options.signal);
    }

    async writeChanges(
        repositoryInput: string,
        context: GitHubAccessContext,
        input: GitHubWriteChangesInput,
        options: GitHubServiceRequestOptions = {},
    ): Promise<GitHubWriteChangesResult> {
        const repository = await this.authorize(repositoryInput, context);
        this.assertWriteAllowed(repository);
        const baseRef = normalizeGitHubRef(input.baseRef);
        const branchName = normalizeGitHubRef(input.branchName);
        if (branchName.startsWith('refs/')) {
            throw new GitHubError('invalid-ref', 'Branch name must not include refs/');
        }
        if (!SHA_PATTERN.test(input.expectedBaseSha)) {
            throw new GitHubError('invalid', 'The approved base commit SHA is invalid');
        }
        if (!input.message.trim() || input.message.length > 5_000) {
            throw new GitHubError('invalid', 'Commit message must be non-empty and reasonably sized');
        }
        if (input.changes.length === 0 || input.changes.length > 500) {
            throw new GitHubError('invalid', 'A write must contain between 1 and 500 file changes');
        }
        const metadata = await this.fetchMetadata(repository, options.signal);
        if (branchName === metadata.defaultBranch || branchName === baseRef) {
            throw new GitHubError('permission', 'Refusing to write directly to the default or base branch');
        }
        const baseHead = await this.retry(
            () => this.fetchBranchHead(repository, baseRef, options.signal),
            options.signal,
        );
        if (baseHead.sha.toLowerCase() !== input.expectedBaseSha.toLowerCase()) {
            throw new GitHubError('conflict', 'The base branch changed after the change set was approved');
        }
        const baseCommit = await this.retry(
            () => this.fetchCommit(repository, baseHead.sha, options.signal),
            options.signal,
        );
        const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
        const seen = new Set<string>();
        let encodedBytes = 0;
        for (const change of input.changes) {
            const path = normalizeWritePath(change.path);
            if (seen.has(path)) {
                throw new GitHubError('invalid', `Duplicate path in change set: ${path}`);
            }
            seen.add(path);
            if (change.status === 'deleted') {
                entries.push({ path, mode: '100644', type: 'blob', sha: null });
                continue;
            }
            if (change.status !== 'added' && change.status !== 'modified' && change.status !== 'renamed') {
                throw new GitHubError('invalid', `Unsupported file change status: ${String(change.status)}`);
            }
            if (!change.contentBase64) {
                throw new GitHubError('invalid', `Missing content for ${path}`);
            }
            encodedBytes += change.contentBase64.length;
            if (encodedBytes > MAX_WRITE_BASE64_CHARS) {
                throw new GitHubError('invalid', 'The approved change set is too large to write safely');
            }
            const content = decodeBase64(change.contentBase64);
            if (change.sha256) {
                const actual = await sha256Hex(content);
                if (actual !== change.sha256.toLowerCase()) {
                    throw new GitHubError('invalid', `Content hash mismatch for ${path}`);
                }
            }
            if (change.status === 'renamed') {
                const previousPath = normalizeWritePath(change.previousPath ?? '');
                if (seen.has(previousPath)) {
                    throw new GitHubError('invalid', `Duplicate path in change set: ${previousPath}`);
                }
                seen.add(previousPath);
                entries.push({ path: previousPath, mode: '100644', type: 'blob', sha: null });
            }
            const blobSha = await this.retry(() => this.createBlob(repository, change, options.signal), options.signal);
            entries.push({ path, mode: '100644', type: 'blob', sha: blobSha });
        }
        const treeSha = await this.retry(
            () => this.createTree(repository, baseCommit.treeSha, entries, options.signal),
            options.signal,
        );
        let branchExists = true;
        let branchHead: GitHubBranchHead | null = null;
        try {
            branchHead = await this.fetchBranchHead(repository, branchName, options.signal);
        } catch (error) {
            if (!(error instanceof GitHubError) || error.code !== 'not-found') {
                throw error;
            }
            branchExists = false;
        }
        if (branchHead && branchHead.sha !== baseHead.sha) {
            const existing = await this.fetchCommit(repository, branchHead.sha, options.signal).catch(error => {
                if (error instanceof GitHubError && error.code === 'not-found') {
                    throw new GitHubError('conflict', 'The target branch already exists with unknown history');
                }
                throw error;
            });
            if (existing.treeSha === treeSha && existing.parentShas.includes(baseHead.sha)) {
                await this.verifyWrite(repository, branchName, branchHead.sha, treeSha, baseHead.sha, options.signal);
                return this.writeResult(
                    repository,
                    baseRef,
                    baseHead.sha,
                    branchName,
                    branchHead.sha,
                    input.changes.length,
                );
            }
            throw new GitHubError('conflict', 'The target branch already exists with different changes');
        }
        if (!branchExists) {
            try {
                await this.retry(
                    () => this.createBranch(repository, branchName, baseHead.sha, options.signal),
                    options.signal,
                );
            } catch (error) {
                const head = await this.fetchBranchHead(repository, branchName, options.signal).catch(() => null);
                if (!head || head.sha !== baseHead.sha) {
                    throw error;
                }
            }
        }
        const commitSha = await this.retry(
            () => this.createCommit(repository, input.message, treeSha, baseHead.sha, options.signal),
            options.signal,
        );
        try {
            await this.retry(
                () => this.updateBranch(repository, branchName, commitSha, options.signal),
                options.signal,
            );
        } catch (error) {
            const head = await this.fetchBranchHead(repository, branchName, options.signal).catch(() => null);
            if (!head) {
                throw error;
            }
            const existing = await this.fetchCommit(repository, head.sha, options.signal).catch(() => null);
            if (!existing || existing.treeSha !== treeSha || !existing.parentShas.includes(baseHead.sha)) {
                throw error;
            }
            return this.writeResult(repository, baseRef, baseHead.sha, branchName, head.sha, input.changes.length);
        }
        await this.verifyWrite(repository, branchName, commitSha, treeSha, baseHead.sha, options.signal);
        return this.writeResult(repository, baseRef, baseHead.sha, branchName, commitSha, input.changes.length);
    }

    private writeResult(
        repository: GitHubAuthorizedRepository,
        baseRef: string,
        baseSha: string,
        branch: string,
        commitSha: string,
        filesChanged: number,
    ): GitHubWriteChangesResult {
        return {
            repository: { owner: repository.owner, name: repository.name, fullName: repository.fullName },
            baseRef,
            baseSha,
            branch,
            commitSha,
            filesChanged,
        };
    }

    private assertWriteAllowed(repository: GitHubAuthorizedRepository): void {
        if (!this.writeRepositories.has(repositoryKey(repository))) {
            throw new GitHubError(
                'permission',
                'GitHub write access is not enabled for this repository. Add it to GITHUB_WRITE_ALLOWED_REPOSITORIES and grant Contents: Read and write.',
            );
        }
        if (!repository.installationId || !this.writeTokenProvider) {
            throw new GitHubError(
                'permission',
                'GitHub App write credentials are not configured. Grant Contents: Read and write and configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.',
            );
        }
    }

    private async fetchBranchHead(
        repository: GitHubAuthorizedRepository,
        ref: string,
        signal: AbortSignal | undefined,
    ): Promise<GitHubBranchHead> {
        const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/ref/heads/${encodeGitHubRef(ref)}`;
        const raw = asRecord(await this.requestJson<unknown>(url, repository, signal));
        const object = asRecord(raw.object);
        const sha = typeof object.sha === 'string' ? object.sha : '';
        assertSha(sha);
        return { ref: typeof raw.ref === 'string' ? raw.ref : `refs/heads/${ref}`, sha };
    }

    private async fetchCommit(
        repository: GitHubAuthorizedRepository,
        sha: string,
        signal: AbortSignal | undefined,
    ): Promise<GitHubCommitInfo> {
        assertSha(sha);
        const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/commits/${encodeURIComponent(sha)}`;
        const raw = asRecord(await this.requestJson<unknown>(url, repository, signal));
        const tree = asRecord(raw.tree);
        const treeSha = typeof tree.sha === 'string' ? tree.sha : '';
        assertSha(treeSha);
        const parents = Array.isArray(raw.parents)
            ? raw.parents.map(parent => {
                  const item = asRecord(parent);
                  return typeof item.sha === 'string' ? item.sha : '';
              })
            : [];
        return { sha, treeSha, parentShas: parents.filter(value => /^[0-9a-f]{40}$/i.test(value)) };
    }

    private async createBlob(
        repository: GitHubAuthorizedRepository,
        change: GitHubFileChangeInput,
        signal: AbortSignal | undefined,
    ): Promise<string> {
        const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/blobs`;
        const raw = asRecord(
            await this.requestWriteJson<unknown>(url, repository, signal, 'POST', {
                content: change.contentBase64,
                encoding: 'base64',
            }),
        );
        const sha = typeof raw.sha === 'string' ? raw.sha : '';
        assertSha(sha);
        return sha;
    }

    private async createTree(
        repository: GitHubAuthorizedRepository,
        baseTreeSha: string,
        entries: { path: string; mode: string; type: string; sha: string | null }[],
        signal: AbortSignal | undefined,
    ): Promise<string> {
        const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees`;
        const raw = asRecord(
            await this.requestWriteJson<unknown>(url, repository, signal, 'POST', {
                base_tree: baseTreeSha,
                tree: entries,
            }),
        );
        const sha = typeof raw.sha === 'string' ? raw.sha : '';
        assertSha(sha);
        return sha;
    }

    private async createCommit(
        repository: GitHubAuthorizedRepository,
        message: string,
        treeSha: string,
        parentSha: string,
        signal: AbortSignal | undefined,
    ): Promise<string> {
        const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/commits`;
        const raw = asRecord(
            await this.requestWriteJson<unknown>(url, repository, signal, 'POST', {
                message,
                tree: treeSha,
                parents: [parentSha],
            }),
        );
        const sha = typeof raw.sha === 'string' ? raw.sha : '';
        assertSha(sha);
        return sha;
    }

    private async createBranch(
        repository: GitHubAuthorizedRepository,
        branchName: string,
        sha: string,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/refs`;
        await this.requestWriteJson<unknown>(url, repository, signal, 'POST', {
            ref: `refs/heads/${branchName}`,
            sha,
        });
    }

    private async updateBranch(
        repository: GitHubAuthorizedRepository,
        branchName: string,
        sha: string,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/refs/heads/${encodeGitHubRef(branchName)}`;
        await this.requestWriteJson<unknown>(url, repository, signal, 'PATCH', { sha, force: false });
    }

    private async verifyWrite(
        repository: GitHubAuthorizedRepository,
        branchName: string,
        commitSha: string,
        treeSha: string,
        parentSha: string,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        const commit = await this.fetchCommit(repository, commitSha, signal);
        if (commit.treeSha !== treeSha || !commit.parentShas.includes(parentSha)) {
            throw new GitHubError('verification', 'Created GitHub commit did not match the approved tree');
        }
        const head = await this.fetchBranchHead(repository, branchName, signal);
        if (head.sha !== commitSha) {
            throw new GitHubError('verification', 'Created GitHub branch did not point at the verified commit');
        }
    }

    private async retry<T>(operation: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (signal?.aborted) {
                throw new GitHubError('aborted', 'GitHub write aborted');
            }
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                if (!(error instanceof GitHubError) || !['api', 'timeout', 'rate-limit'].includes(error.code)) {
                    throw error;
                }
                if (attempt === 2) {
                    break;
                }
                await new Promise(resolve =>
                    setTimeout(resolve, Math.min(1_000, (error.retryAfterSeconds ?? 0.01) * 1_000)),
                );
            }
        }
        throw lastError;
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
        write = false,
    ): Promise<Record<string, string>> {
        if (!repository.installationId) {
            return {};
        }
        const provider = write ? this.writeTokenProvider : this.tokenProvider;
        if (!provider) {
            throw new GitHubError(
                write ? 'permission' : 'auth',
                write
                    ? 'GitHub App write token provider is not configured. Grant Contents: Read and write and configure the App credentials.'
                    : 'GitHub App token provider is not configured',
            );
        }
        try {
            const token = await provider.getInstallationToken(repository.installationId, repository, { signal });
            return { authorization: `Bearer ${token.token}` };
        } catch (error) {
            if (write && error instanceof GitHubError && (error.code === 'unauthorized' || error.status === 403)) {
                throw new GitHubError(
                    'permission',
                    'GitHub App is missing Contents: Read and write permission for this repository',
                    { cause: error, status: error.status },
                );
            }
            throw error;
        }
    }

    private async requestJsonWithHeaders<T>(
        url: string,
        headers: Record<string, string>,
        signal: AbortSignal | undefined,
    ): Promise<T> {
        const response = await fetchGitHubResponse(url, {
            fetchImpl: this.fetchImpl,
            signal,
            timeoutMs: this.timeoutMs,
            headers,
        });
        if (!response.ok) {
            throw mapGitHubHttpError(response);
        }
        return readGitHubResponseJson<T>(response, this.maxJsonBytes, signal, this.timeoutMs);
    }

    private async requestJson<T>(
        url: string,
        repository: GitHubAuthorizedRepository,
        signal: AbortSignal | undefined,
    ): Promise<T> {
        return this.requestJsonWithHeaders(url, await this.authHeaders(repository, signal), signal);
    }

    private async requestWriteJson<T>(
        url: string,
        repository: GitHubAuthorizedRepository,
        signal: AbortSignal | undefined,
        method: string,
        body: unknown,
    ): Promise<T> {
        try {
            const response = await fetchGitHubResponse(url, {
                fetchImpl: this.fetchImpl,
                signal,
                timeoutMs: this.timeoutMs,
                method,
                headers: {
                    ...(await this.authHeaders(repository, signal, true)),
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                throw mapGitHubHttpError(response);
            }
            return readGitHubResponseJson<T>(response, this.maxJsonBytes, signal, this.timeoutMs);
        } catch (error) {
            if (error instanceof GitHubError && (error.code === 'unauthorized' || error.status === 403)) {
                throw new GitHubError(
                    'permission',
                    'GitHub App is missing Contents: Read and write permission for this repository',
                    { cause: error, status: error.status },
                );
            }
            throw error;
        }
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
