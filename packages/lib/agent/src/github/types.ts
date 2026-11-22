export interface GitHubRepositoryRef {
    owner: string;
    name: string;
    fullName: string;
}

export interface GitHubAccessContext {
    userId: string;
    chatId?: string;
    repository?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
}

export interface GitHubAuthorizedRepository extends GitHubRepositoryRef {
    installationId?: string;
}

export interface GitHubRepositoryMetadata {
    fullName: string;
    owner: string;
    name: string;
    private: boolean;
    defaultBranch: string;
    description: string | null;
    htmlUrl: string;
    language: string | null;
    sizeKb: number;
    archived: boolean;
    updatedAt?: string;
}

export interface GitHubRepositoryFile {
    path: string;
    content: Uint8Array;
    size: number;
}

export interface GitHubRepositoryArchive {
    repository: GitHubRepositoryRef;
    ref: string;
    commitSha?: string;
    files: GitHubRepositoryFile[];
    totalBytes: number;
    skippedFiles: number;
}

export interface GitHubCheckoutResult {
    repository: GitHubRepositoryRef;
    ref: string;
    commitSha?: string;
    filesWritten: number;
    bytesWritten: number;
    skippedFiles: number;
}

export type GitHubFileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitHubFileChangeInput {
    path: string;
    previousPath?: string;
    status: GitHubFileChangeStatus;
    /** Base64-encoded new content. Required unless the file is deleted. */
    contentBase64?: string;
    /** Expected SHA-256 of the new content, hex encoded. */
    sha256?: string;
}

export interface GitHubWriteChangesInput {
    baseRef: string;
    expectedBaseSha: string;
    branchName: string;
    message: string;
    changes: readonly GitHubFileChangeInput[];
}

export interface GitHubBranchHead {
    ref: string;
    sha: string;
}

export interface GitHubWriteChangesResult {
    repository: GitHubRepositoryRef;
    baseRef: string;
    baseSha: string;
    branch: string;
    commitSha: string;
    filesChanged: number;
}

export interface GitHubCommitInfo {
    sha: string;
    treeSha: string;
    parentShas: string[];
}
