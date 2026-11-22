export interface SandboxScope {
    userId: string;
    repository: string;
    sessionId?: string;
}

export interface SandboxWorkspace {
    userId: string;
    repository: string;
    sessionId: string;
    /** Stable hash used for the Durable Object / provider sandbox name. */
    id: string;
    /** Provider-specific sandbox name derived from `id`. */
    name: string;
    /** Absolute directory that the path-based methods may access. */
    rootDir: string;
}

export type SandboxEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SandboxDirectoryEntry {
    name: string;
    type: SandboxEntryType;
}

export interface SandboxExecOptions {
    /** Relative working directory inside the workspace. */
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
}

export interface SandboxExecResult {
    command: string;
    cwd: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    /** True when stdout or stderr was cut at `maxOutputBytes`. */
    truncated: boolean;
    durationMs: number;
}

export type SandboxFileContent = string | Uint8Array | ArrayBuffer;

export interface SandboxFileOptions {
    signal?: AbortSignal;
    /** Upper bound for readFile. Defaults to the client limit. */
    maxBytes?: number;
}

export interface SandboxRemoveOptions {
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
}

export interface SandboxListOptions {
    signal?: AbortSignal;
    maxEntries?: number;
}

export interface SandboxListResult {
    path: string;
    entries: SandboxDirectoryEntry[];
    truncated: boolean;
}

export interface SandboxSnapshotOptions {
    name?: string;
    signal?: AbortSignal;
}

export interface SandboxSnapshot {
    id: string;
    size: number;
    name?: string;
    createdAt: number;
}

export interface SandboxClient {
    readonly workspace: SandboxWorkspace;

    exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;
    readFile(path: string, options?: SandboxFileOptions): Promise<Uint8Array>;
    writeFile(path: string, content: SandboxFileContent, options?: SandboxFileOptions): Promise<void>;
    rename(from: string, to: string, options?: SandboxFileOptions): Promise<void>;
    remove(path: string, options?: SandboxRemoveOptions): Promise<void>;
    list(path?: string, options?: SandboxListOptions): Promise<SandboxListResult>;
    snapshot(options?: SandboxSnapshotOptions): Promise<SandboxSnapshot>;
    destroy(): Promise<void>;
}
