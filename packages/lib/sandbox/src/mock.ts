import { raceWithAbort } from './abort';
import {
    SandboxAbortError,
    SandboxDisposedError,
    SandboxExecError,
    SandboxFileError,
    SandboxLimitError,
    SandboxTimeoutError,
} from './errors';
import {
    DEFAULT_EXEC_TIMEOUT_MS,
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_LIST_ENTRIES,
    DEFAULT_MAX_OUTPUT_BYTES,
    MAX_COMMAND_LENGTH,
    MAX_EXEC_TIMEOUT_MS,
    MAX_MAX_FILE_BYTES,
    MAX_MAX_LIST_ENTRIES,
    MAX_MAX_OUTPUT_BYTES,
    clampInt,
} from './limits';
import { normalizeRelativePath, parentSandboxPath } from './path';
import type {
    SandboxClient,
    SandboxDirectoryEntry,
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

export interface MockExecRequest {
    command: string;
    cwd: string;
    signal?: AbortSignal;
    client: MockSandboxClient;
}

export interface MockExecResult {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
}

export type MockExecHandler = (request: MockExecRequest) => MockExecResult | Promise<MockExecResult>;

export interface MockSandboxClientOptions {
    workspace: SandboxWorkspace;
    files?: Record<string, SandboxFileContent>;
    execHandler?: MockExecHandler;
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

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength <= maxBytes) {
        return { text: value, truncated: false };
    }
    return {
        text: new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes)),
        truncated: true,
    };
}

/** In-memory SandboxClient for tests and local development. */
export class MockSandboxClient implements SandboxClient {
    readonly workspace: SandboxWorkspace;
    readonly commands: string[] = [];

    private readonly files = new Map<string, Uint8Array>();
    private readonly directories = new Set<string>(['']);
    private readonly snapshots = new Map<string, { files: Map<string, Uint8Array>; dirs: Set<string> }>();
    private readonly execHandler: MockExecHandler | undefined;
    private disposed = false;
    private snapshotCounter = 0;

    constructor(options: MockSandboxClientOptions) {
        this.workspace = options.workspace;
        this.execHandler = options.execHandler;
        for (const [path, content] of Object.entries(options.files ?? {})) {
            this.putFile(path, toBytes(content));
        }
    }

    async exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
        this.ensureAlive();
        const trimmed = command.trim();
        if (!trimmed) {
            throw new SandboxExecError('Command must not be empty');
        }
        if (trimmed.length > MAX_COMMAND_LENGTH) {
            throw new SandboxLimitError(`Command is too long (max ${MAX_COMMAND_LENGTH} characters)`);
        }
        const cwd = normalizeRelativePath(options.cwd ?? '');
        this.assertDirectory(cwd, 'exec');
        this.commands.push(trimmed);

        const timeoutMs = clampInt(options.timeoutMs, 1, MAX_EXEC_TIMEOUT_MS, DEFAULT_EXEC_TIMEOUT_MS);
        const maxOutputBytes = clampInt(options.maxOutputBytes, 1, MAX_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);
        const started = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const work = this.execHandler
                ? Promise.resolve(this.execHandler({ command: trimmed, cwd, signal: options.signal, client: this }))
                : Promise.resolve<MockExecResult>({ exitCode: 0, stdout: '', stderr: '' });
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new SandboxTimeoutError(`Command timed out after ${timeoutMs} ms`)),
                    timeoutMs,
                );
            });
            const result = await Promise.race([options.signal ? raceWithAbort(work, options.signal) : work, timeout]);
            const stdout = truncateUtf8(result.stdout ?? '', maxOutputBytes);
            const stderr = truncateUtf8(result.stderr ?? '', maxOutputBytes);
            return {
                command: trimmed,
                cwd,
                exitCode: result.exitCode ?? 0,
                stdout: stdout.text,
                stderr: stderr.text,
                truncated: stdout.truncated || stderr.truncated,
                durationMs: Date.now() - started,
            };
        } catch (error) {
            if (error instanceof SandboxTimeoutError) {
                throw error;
            }
            if (options.signal?.aborted) {
                throw new SandboxAbortError('Command aborted', { cause: error });
            }
            if (error instanceof SandboxAbortError) {
                throw error;
            }
            throw new SandboxExecError(error instanceof Error ? error.message : String(error), { cause: error });
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    async readFile(path: string, options: SandboxFileOptions = {}): Promise<Uint8Array> {
        this.ensureAlive();
        const key = normalizeRelativePath(path);
        const file = this.files.get(key);
        if (!file) {
            throw new SandboxFileError('readFile', key, `File not found: ${key}`, 'ENOENT');
        }
        const maxBytes = clampInt(options.maxBytes, 1, MAX_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
        if (file.byteLength > maxBytes) {
            throw new SandboxLimitError(`File exceeds the read limit (${maxBytes} bytes)`);
        }
        return new Uint8Array(file);
    }

    async writeFile(path: string, content: SandboxFileContent, _options: SandboxFileOptions = {}): Promise<void> {
        this.ensureAlive();
        const key = normalizeRelativePath(path);
        if (!key) {
            throw new SandboxFileError('writeFile', key, 'Cannot write to the workspace root', 'EISDIR');
        }
        this.putFile(key, toBytes(content));
    }

    async rename(from: string, to: string, _options: SandboxFileOptions = {}): Promise<void> {
        this.ensureAlive();
        const source = normalizeRelativePath(from);
        const destination = normalizeRelativePath(to);
        if (!source || !destination || source === destination) {
            return;
        }
        if (this.files.has(source)) {
            this.ensureParent(destination);
            if (this.directories.has(destination)) {
                throw new SandboxFileError('rename', source, `Destination is a directory: ${destination}`, 'EISDIR');
            }
            const content = this.files.get(source)!;
            this.files.delete(source);
            this.files.set(destination, content);
            return;
        }
        if (this.directories.has(source)) {
            if (this.files.has(destination)) {
                throw new SandboxFileError('rename', source, `Destination is a file: ${destination}`, 'EEXIST');
            }
            if (this.directories.has(destination) && this.hasChildren(destination)) {
                throw new SandboxFileError('rename', source, `Destination is not empty: ${destination}`, 'ENOTEMPTY');
            }
            this.ensureParent(destination);
            const prefix = `${source}/`;
            for (const [path, content] of Array.from(this.files)) {
                if (path.startsWith(prefix)) {
                    this.files.delete(path);
                    this.files.set(`${destination}/${path.slice(prefix.length)}`, content);
                }
            }
            for (const path of Array.from(this.directories)) {
                if (path === source || path.startsWith(prefix)) {
                    this.directories.delete(path);
                    this.directories.add(`${destination}${path.slice(source.length)}`);
                }
            }
            return;
        }
        throw new SandboxFileError('rename', source, `Path not found: ${source}`, 'ENOENT');
    }

    async remove(path: string, options: SandboxRemoveOptions = {}): Promise<void> {
        this.ensureAlive();
        const key = normalizeRelativePath(path);
        if (!key) {
            throw new SandboxFileError('remove', key, 'Cannot remove the workspace root', 'EISDIR');
        }
        if (this.files.has(key)) {
            this.files.delete(key);
            return;
        }
        if (!this.directories.has(key)) {
            if (options.force) {
                return;
            }
            throw new SandboxFileError('remove', key, `Path not found: ${key}`, 'ENOENT');
        }
        if (!options.recursive && this.hasChildren(key)) {
            throw new SandboxFileError('remove', key, `Directory is not empty: ${key}`, 'ENOTEMPTY');
        }
        const prefix = `${key}/`;
        for (const child of Array.from(this.files.keys())) {
            if (child.startsWith(prefix)) {
                this.files.delete(child);
            }
        }
        for (const dir of Array.from(this.directories)) {
            if (dir === key || dir.startsWith(prefix)) {
                this.directories.delete(dir);
            }
        }
    }

    async list(path = '', options: SandboxListOptions = {}): Promise<SandboxListResult> {
        this.ensureAlive();
        const key = normalizeRelativePath(path);
        this.assertDirectory(key, 'readDirectory');
        const maxEntries = clampInt(options.maxEntries, 1, MAX_MAX_LIST_ENTRIES, DEFAULT_MAX_LIST_ENTRIES);
        const entries: SandboxDirectoryEntry[] = [];
        const prefix = key ? `${key}/` : '';
        for (const file of this.files.keys()) {
            if (!file.startsWith(prefix)) {
                continue;
            }
            const rest = file.slice(prefix.length);
            if (rest && !rest.includes('/')) {
                entries.push({ name: rest, type: 'file' });
            }
        }
        for (const dir of this.directories) {
            if (!dir || !dir.startsWith(prefix) || dir === key) {
                continue;
            }
            const rest = dir.slice(prefix.length);
            if (rest && !rest.includes('/')) {
                entries.push({ name: rest, type: 'directory' });
            }
        }
        entries.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
        const truncated = entries.length > maxEntries;
        return { path: key, entries: truncated ? entries.slice(0, maxEntries) : entries, truncated };
    }

    async snapshot(options: SandboxSnapshotOptions = {}): Promise<SandboxSnapshot> {
        this.ensureAlive();
        if (options.signal?.aborted) {
            throw new SandboxAbortError('Snapshot aborted', { cause: options.signal.reason });
        }
        const id = `snapshot-${++this.snapshotCounter}`;
        this.snapshots.set(id, {
            files: new Map(this.files),
            dirs: new Set(this.directories),
        });
        let size = 0;
        for (const file of this.files.values()) {
            size += file.byteLength;
        }
        return { id, size, name: options.name, createdAt: Date.now() };
    }

    async destroy(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.files.clear();
        this.directories.clear();
        this.snapshots.clear();
    }

    private putFile(path: string, content: Uint8Array): void {
        const key = normalizeRelativePath(path);
        if (!key) {
            throw new SandboxFileError('writeFile', key, 'Cannot write to the workspace root', 'EISDIR');
        }
        if (content.byteLength > MAX_MAX_FILE_BYTES) {
            throw new SandboxLimitError(`File exceeds the maximum size (${MAX_MAX_FILE_BYTES} bytes)`);
        }
        this.ensureParent(key);
        if (this.directories.has(key)) {
            throw new SandboxFileError('writeFile', key, `Path is a directory: ${key}`, 'EISDIR');
        }
        this.files.set(key, new Uint8Array(content));
    }

    private ensureParent(path: string): void {
        const parent = parentSandboxPath(path);
        if (!parent) {
            return;
        }
        if (this.files.has(parent)) {
            throw new SandboxFileError('mkdir', parent, `Parent is a file: ${parent}`, 'ENOTDIR');
        }
        const parts = parent.split('/');
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            this.directories.add(current);
        }
    }

    private hasChildren(path: string): boolean {
        const prefix = `${path}/`;
        return (
            [...this.files.keys()].some(file => file.startsWith(prefix)) ||
            [...this.directories].some(dir => dir.startsWith(prefix))
        );
    }

    private assertDirectory(path: string, operation: string): void {
        if (this.files.has(path)) {
            throw new SandboxFileError(operation, path, `Path is not a directory: ${path}`, 'ENOTDIR');
        }
        if (!this.directories.has(path)) {
            throw new SandboxFileError(operation, path, `Directory not found: ${path}`, 'ENOENT');
        }
    }

    private ensureAlive(): void {
        if (this.disposed) {
            throw new SandboxDisposedError();
        }
    }
}
