import { Files, SandboxFileError as CloudflareSandboxFileError } from '@cloudflare/sandbox';
import { createAbortScope, raceWithAbort } from './abort';
import {
    SandboxAbortError,
    SandboxDisposedError,
    SandboxError,
    SandboxExecError,
    SandboxFileError,
    SandboxLimitError,
    SandboxTimeoutError,
} from './errors';
import {
    DEFAULT_EXEC_TIMEOUT_MS,
    DEFAULT_INACTIVITY_TIMEOUT_MS,
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_LIST_ENTRIES,
    DEFAULT_MAX_OUTPUT_BYTES,
    MAX_COMMAND_LENGTH,
    MAX_EXEC_TIMEOUT_MS,
    MAX_INACTIVITY_TIMEOUT_MS,
    MAX_MAX_FILE_BYTES,
    MAX_MAX_LIST_ENTRIES,
    MAX_MAX_OUTPUT_BYTES,
    clampInt,
} from './limits';
import { normalizeRelativePath, parentSandboxPath, resolveSandboxPath } from './path';
import { readResponseLimited, readStreamLimited } from './stream';
import type {
    SandboxClient,
    SandboxEntryType,
    SandboxExecOptions,
    SandboxExecResult,
    SandboxFileContent,
    SandboxFileOptions,
    SandboxListOptions,
    SandboxListResult,
    SandboxRemoveOptions,
    SandboxSnapshot,
    SandboxSnapshotOptions,
    SandboxWorkspace,
} from './types';

export type CloudflareContainerInstance = 'lite' | 'basic' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4';

export interface CloudflareContainerStartOptions {
    image: string;
    enableInternet?: boolean;
    instance?: CloudflareContainerInstance;
    entrypoint?: string[];
    labels?: Record<string, string>;
}

export interface CloudflareExecProcess {
    readonly stdout: ReadableStream<Uint8Array> | null;
    readonly stderr: ReadableStream<Uint8Array> | null;
    readonly exitCode: Promise<number>;
    kill(signal?: number): void;
}

/** The subset of the official Durable Object Container API used by this adapter. */
export interface CloudflareContainer {
    readonly running: boolean;
    readonly images: Record<string, string>;
    start(options: CloudflareContainerStartOptions): void;
    destroy(error?: unknown): Promise<void>;
    setInactivityTimeout(durationMs: number | bigint): Promise<void>;
    snapshotContainer(options?: { name?: string }): Promise<{ id: string; size: number; name?: string }>;
    exec(
        cmd: string[],
        options?: {
            cwd?: string;
            env?: Record<string, string>;
            signal?: AbortSignal;
            stdout?: 'pipe' | 'ignore';
            stderr?: 'pipe' | 'ignore' | 'combined';
        },
    ): Promise<CloudflareExecProcess>;
}

/** The subset of `Files` from @cloudflare/sandbox used by this adapter. */
export interface CloudflareFiles {
    readFile(path: string, options?: { signal?: AbortSignal }): Promise<Response>;
    writeFile(
        path: string,
        content: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>,
        options?: { signal?: AbortSignal },
    ): Promise<void>;
    rename(source: string, destination: string, options?: { signal?: AbortSignal }): Promise<void>;
    remove(path: string, options?: { recursive?: boolean; force?: boolean; signal?: AbortSignal }): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void>;
    readDirectory(path: string, options?: { signal?: AbortSignal }): Promise<Array<{ name: string; type: string }>>;
}

export interface CloudflareSandboxState {
    readonly container?: CloudflareContainer;
}

export interface CloudflareSandboxClientOptions {
    workspace: SandboxWorkspace;
    container: CloudflareContainer;
    /** Injected in tests; defaults to the official Files API. */
    files?: CloudflareFiles;
    /** Image name from `container.images`, or a direct image reference. */
    image?: string;
    imageName?: string;
    instance?: CloudflareContainerInstance;
    inactivityTimeoutMs?: number;
    shell?: string;
    execTimeoutMs?: number;
    maxOutputBytes?: number;
    maxFileBytes?: number;
    maxListEntries?: number;
}

function toBytes(content: SandboxFileContent): Uint8Array {
    if (typeof content === 'string') {
        return new TextEncoder().encode(content);
    }
    if (content instanceof Uint8Array) {
        return new Uint8Array(content);
    }
    return new Uint8Array(content);
}

function mapEntryType(type: string): SandboxEntryType {
    if (type === 'file' || type === 'directory' || type === 'symlink') {
        return type;
    }
    return 'other';
}

function mapFileError(error: unknown, operation: string, path: string, signal?: AbortSignal): SandboxError {
    if (error instanceof SandboxError) {
        return error;
    }
    if (signal?.aborted) {
        return new SandboxAbortError('File operation aborted', { cause: error });
    }
    if (CloudflareSandboxFileError.is(error)) {
        return new SandboxFileError(operation, path, error.message, error.code, { cause: error });
    }
    return new SandboxFileError(operation, path, error instanceof Error ? error.message : String(error), undefined, {
        cause: error,
    });
}

/** Creates a client from the `ctx` of a Durable Object with a container binding. */
export function createCloudflareSandboxClient(
    state: CloudflareSandboxState,
    options: Omit<CloudflareSandboxClientOptions, 'container'>,
): CloudflareSandboxClient {
    if (!state.container) {
        throw new SandboxError('unsupported', 'No container is configured for this Durable Object');
    }
    return new CloudflareSandboxClient({ ...options, container: state.container });
}

/** Cloudflare Containers + @cloudflare/sandbox implementation of SandboxClient. */
export class CloudflareSandboxClient implements SandboxClient {
    readonly workspace: SandboxWorkspace;

    private readonly container: CloudflareContainer;
    private readonly files: CloudflareFiles;
    private readonly image: string | undefined;
    private readonly imageName: string | undefined;
    private readonly instance: CloudflareContainerInstance | undefined;
    private readonly inactivityTimeoutMs: number;
    private readonly shell: string;
    private readonly execTimeoutMs: number;
    private readonly maxOutputBytes: number;
    private readonly maxFileBytes: number;
    private readonly maxListEntries: number;
    private disposed = false;

    constructor(options: CloudflareSandboxClientOptions) {
        this.workspace = options.workspace;
        this.container = options.container;
        this.image = options.image;
        this.imageName = options.imageName;
        this.instance = options.instance ?? 'basic';
        this.inactivityTimeoutMs = clampInt(
            options.inactivityTimeoutMs,
            1,
            MAX_INACTIVITY_TIMEOUT_MS,
            DEFAULT_INACTIVITY_TIMEOUT_MS,
        );
        this.shell = options.shell ?? 'bash';
        this.execTimeoutMs = clampInt(options.execTimeoutMs, 1, MAX_EXEC_TIMEOUT_MS, DEFAULT_EXEC_TIMEOUT_MS);
        this.maxOutputBytes = clampInt(options.maxOutputBytes, 1, MAX_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);
        this.maxFileBytes = clampInt(options.maxFileBytes, 1, MAX_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
        this.maxListEntries = clampInt(options.maxListEntries, 1, MAX_MAX_LIST_ENTRIES, DEFAULT_MAX_LIST_ENTRIES);
        this.files =
            options.files ??
            (new Files(
                this.container as unknown as ConstructorParameters<typeof Files>[0],
            ) as unknown as CloudflareFiles);
    }

    async exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
        this.ensureAlive();
        this.ensureNotAborted(options.signal);
        await this.ensureStarted();

        const trimmed = command.trim();
        if (!trimmed) {
            throw new SandboxExecError('Command must not be empty');
        }
        if (trimmed.length > MAX_COMMAND_LENGTH) {
            throw new SandboxLimitError(`Command is too long (max ${MAX_COMMAND_LENGTH} characters)`);
        }

        const cwd = resolveSandboxPath(this.workspace.rootDir, options.cwd ?? '');
        const timeoutMs = clampInt(options.timeoutMs, 1, MAX_EXEC_TIMEOUT_MS, this.execTimeoutMs);
        const maxOutputBytes = clampInt(options.maxOutputBytes, 1, MAX_MAX_OUTPUT_BYTES, this.maxOutputBytes);
        const scope = createAbortScope(options.signal, timeoutMs);
        const started = Date.now();
        let process: CloudflareExecProcess | undefined;

        try {
            process = await this.container.exec([this.shell, '-lc', trimmed], {
                cwd,
                signal: scope.signal,
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                readStreamLimited(process.stdout, maxOutputBytes, scope.signal),
                readStreamLimited(process.stderr, maxOutputBytes, scope.signal),
                raceWithAbort(process.exitCode, scope.signal),
            ]);
            return {
                command: trimmed,
                cwd,
                exitCode,
                stdout: new TextDecoder('utf-8', { fatal: false }).decode(stdout.bytes),
                stderr: new TextDecoder('utf-8', { fatal: false }).decode(stderr.bytes),
                truncated: stdout.truncated || stderr.truncated,
                durationMs: Date.now() - started,
            };
        } catch (error) {
            try {
                process?.kill(15);
            } catch {
                // The process may already have exited.
            }
            if (scope.timedOut()) {
                throw new SandboxTimeoutError(`Command timed out after ${timeoutMs} ms`, { cause: error });
            }
            if (options.signal?.aborted) {
                throw new SandboxAbortError('Command aborted', { cause: error });
            }
            if (error instanceof SandboxError) {
                throw error;
            }
            throw new SandboxExecError(error instanceof Error ? error.message : String(error), { cause: error });
        } finally {
            scope.clear();
        }
    }

    async readFile(path: string, options: SandboxFileOptions = {}): Promise<Uint8Array> {
        this.ensureAlive();
        this.ensureNotAborted(options.signal);
        await this.ensureStarted();
        const relative = normalizeRelativePath(path);
        const absolute = resolveSandboxPath(this.workspace.rootDir, relative);
        const maxBytes = clampInt(options.maxBytes, 1, this.maxFileBytes, this.maxFileBytes);
        try {
            const response = await this.files.readFile(absolute, { signal: options.signal });
            const limited = await readResponseLimited(response, maxBytes, options.signal);
            if (limited.truncated) {
                throw new SandboxLimitError(`File exceeds the read limit (${maxBytes} bytes)`);
            }
            return limited.bytes;
        } catch (error) {
            if (error instanceof SandboxError) {
                throw error;
            }
            throw mapFileError(error, 'readFile', relative, options.signal);
        }
    }

    async writeFile(path: string, content: SandboxFileContent, options: SandboxFileOptions = {}): Promise<void> {
        this.ensureAlive();
        this.ensureNotAborted(options.signal);
        await this.ensureStarted();
        const relative = normalizeRelativePath(path);
        if (!relative) {
            throw new SandboxFileError('writeFile', relative, 'Cannot write to the workspace root', 'EISDIR');
        }
        const bytes = toBytes(content);
        if (bytes.byteLength > this.maxFileBytes) {
            throw new SandboxLimitError(`File exceeds the write limit (${this.maxFileBytes} bytes)`);
        }
        const absolute = resolveSandboxPath(this.workspace.rootDir, relative);
        const parent = parentSandboxPath(relative);
        try {
            if (parent) {
                await this.files.mkdir(resolveSandboxPath(this.workspace.rootDir, parent), {
                    recursive: true,
                    signal: options.signal,
                });
            }
            await this.files.writeFile(absolute, bytes, { signal: options.signal });
        } catch (error) {
            throw mapFileError(error, 'writeFile', relative, options.signal);
        }
    }

    async rename(from: string, to: string, options: SandboxFileOptions = {}): Promise<void> {
        this.ensureAlive();
        this.ensureNotAborted(options.signal);
        await this.ensureStarted();
        const source = normalizeRelativePath(from);
        const destination = normalizeRelativePath(to);
        if (!source || !destination) {
            throw new SandboxFileError('rename', source || destination, 'Source and destination must not be empty');
        }
        const parent = parentSandboxPath(destination);
        try {
            if (parent) {
                await this.files.mkdir(resolveSandboxPath(this.workspace.rootDir, parent), {
                    recursive: true,
                    signal: options.signal,
                });
            }
            await this.files.rename(
                resolveSandboxPath(this.workspace.rootDir, source),
                resolveSandboxPath(this.workspace.rootDir, destination),
                { signal: options.signal },
            );
        } catch (error) {
            throw mapFileError(error, 'rename', source, options.signal);
        }
    }

    async remove(path: string, options: SandboxRemoveOptions = {}): Promise<void> {
        this.ensureAlive();
        this.ensureNotAborted(options.signal);
        await this.ensureStarted();
        const relative = normalizeRelativePath(path);
        if (!relative) {
            throw new SandboxFileError('remove', relative, 'Cannot remove the workspace root', 'EISDIR');
        }
        try {
            await this.files.remove(resolveSandboxPath(this.workspace.rootDir, relative), {
                recursive: options.recursive,
                force: options.force,
                signal: options.signal,
            });
        } catch (error) {
            throw mapFileError(error, 'remove', relative, options.signal);
        }
    }

    async list(path = '', options: SandboxListOptions = {}): Promise<SandboxListResult> {
        this.ensureAlive();
        this.ensureNotAborted(options.signal);
        await this.ensureStarted();
        const relative = normalizeRelativePath(path);
        const maxEntries = clampInt(options.maxEntries, 1, MAX_MAX_LIST_ENTRIES, this.maxListEntries);
        try {
            const entries = await this.files.readDirectory(resolveSandboxPath(this.workspace.rootDir, relative), {
                signal: options.signal,
            });
            const mapped = entries
                .map(entry => ({ name: entry.name, type: mapEntryType(entry.type) }))
                .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
            const truncated = mapped.length > maxEntries;
            return {
                path: relative,
                entries: truncated ? mapped.slice(0, maxEntries) : mapped,
                truncated,
            };
        } catch (error) {
            throw mapFileError(error, 'readDirectory', relative, options.signal);
        }
    }

    async snapshot(options: SandboxSnapshotOptions = {}): Promise<SandboxSnapshot> {
        this.ensureAlive();
        this.ensureNotAborted(options.signal);
        await this.ensureStarted();
        try {
            const snapshot = await this.container.snapshotContainer({ name: options.name });
            return { ...snapshot, createdAt: Date.now() };
        } catch (error) {
            throw new SandboxError('snapshot', error instanceof Error ? error.message : String(error), {
                cause: error,
            });
        }
    }

    async destroy(): Promise<void> {
        if (this.disposed) {
            return;
        }
        try {
            await this.container.destroy();
        } finally {
            this.disposed = true;
        }
    }

    private async ensureStarted(): Promise<void> {
        if (this.container.running) {
            await this.container.setInactivityTimeout(this.inactivityTimeoutMs);
            return;
        }
        const image =
            this.image ?? this.container.images[this.imageName ?? Object.keys(this.container.images)[0] ?? ''];
        if (!image) {
            throw new SandboxError('unsupported', 'No container image is configured');
        }
        this.container.start({
            image,
            enableInternet: false,
            instance: this.instance,
        });
        await this.container.setInactivityTimeout(this.inactivityTimeoutMs);
    }

    private ensureAlive(): void {
        if (this.disposed) {
            throw new SandboxDisposedError();
        }
    }

    private ensureNotAborted(signal?: AbortSignal): void {
        if (signal?.aborted) {
            throw new SandboxAbortError('Operation aborted', { cause: signal.reason });
        }
    }
}
