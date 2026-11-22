export interface GitHubRepositoryRef {
    owner: string;
    name: string;
    fullName: string;
}

export interface GitHubAccessContext {
    userId: string;
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
