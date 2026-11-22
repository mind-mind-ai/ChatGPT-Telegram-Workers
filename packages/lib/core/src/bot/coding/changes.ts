import type { GitHubService } from '@chatgpt-telegram-workers/agent';
import type { SandboxClient } from '@chatgpt-telegram-workers/sandbox';
import { CodingSessionError, type CodingChangeFile, type CodingChangeSet } from './types';

export interface CodingChangeLimits {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxDiffBytes: number;
}

export const DEFAULT_CODING_CHANGE_LIMITS: CodingChangeLimits = {
    maxFiles: 5_000,
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 12 * 1024 * 1024,
    maxDiffBytes: 4 * 1024 * 1024,
};

export interface CodingChangeSession {
    userId: string;
    chatId: string;
    repository: string;
    sessionId: string;
}

export interface CollectCodingChangesOptions {
    session: CodingChangeSession;
    baseRef: string;
    baseCommitSha: string;
    github: GitHubService;
    sandbox: SandboxClient;
    signal?: AbortSignal;
    now?: () => number;
    limits?: Partial<CodingChangeLimits>;
}

interface FileContent {
    path: string;
    bytes: Uint8Array;
    sha256: string;
}

type DiffOperation = { type: 'equal' | 'delete' | 'insert'; line: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

function toHex(bytes: Uint8Array): string {
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)));
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
}

function isBinary(bytes: Uint8Array): boolean {
    return bytes.includes(0);
}

function splitLines(value: string): string[] {
    if (!value) {
        return [];
    }
    const lines = value.split('\n');
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

function diffLines(oldLines: string[], newLines: string[]): DiffOperation[] {
    if (oldLines.length === 0) {
        return newLines.map(line => ({ type: 'insert', line }));
    }
    if (newLines.length === 0) {
        return oldLines.map(line => ({ type: 'delete', line }));
    }
    if (oldLines.length * newLines.length > 2_000_000) {
        return [
            ...oldLines.map(line => ({ type: 'delete' as const, line })),
            ...newLines.map(line => ({ type: 'insert' as const, line })),
        ];
    }
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
            table[oldIndex * cols + newIndex] =
                oldLines[oldIndex] === newLines[newIndex]
                    ? table[(oldIndex + 1) * cols + newIndex + 1] + 1
                    : Math.max(table[(oldIndex + 1) * cols + newIndex], table[oldIndex * cols + newIndex + 1]);
        }
    }
    const operations: DiffOperation[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        if (oldLines[oldIndex] === newLines[newIndex]) {
            operations.push({ type: 'equal', line: oldLines[oldIndex] });
            oldIndex += 1;
            newIndex += 1;
        } else if (table[(oldIndex + 1) * cols + newIndex] >= table[oldIndex * cols + newIndex + 1]) {
            operations.push({ type: 'delete', line: oldLines[oldIndex] });
            oldIndex += 1;
        } else {
            operations.push({ type: 'insert', line: newLines[newIndex] });
            newIndex += 1;
        }
    }
    while (oldIndex < oldLines.length) {
        operations.push({ type: 'delete', line: oldLines[oldIndex++] });
    }
    while (newIndex < newLines.length) {
        operations.push({ type: 'insert', line: newLines[newIndex++] });
    }
    return operations;
}

function hunkRanges(operations: DiffOperation[], context = 3): [number, number][] {
    const changed = operations.map((operation, index) => (operation.type === 'equal' ? -1 : index)).filter(i => i >= 0);
    if (changed.length === 0) {
        return [];
    }
    const ranges: [number, number][] = [];
    let start = Math.max(0, changed[0] - context);
    let end = Math.min(operations.length, changed[0] + context + 1);
    for (const index of changed.slice(1)) {
        if (index - context <= end) {
            end = Math.min(operations.length, index + context + 1);
        } else {
            ranges.push([start, end]);
            start = Math.max(0, index - context);
            end = Math.min(operations.length, index + context + 1);
        }
    }
    ranges.push([start, end]);
    return ranges;
}

function unifiedHunks(operations: DiffOperation[]): string[] {
    const ranges = hunkRanges(operations);
    const result: string[] = [];
    for (const [start, end] of ranges) {
        let oldLine = 1;
        let newLine = 1;
        for (let index = 0; index < start; index += 1) {
            if (operations[index].type !== 'insert') oldLine += 1;
            if (operations[index].type !== 'delete') newLine += 1;
        }
        let oldCount = 0;
        let newCount = 0;
        const lines: string[] = [];
        for (let index = start; index < end; index += 1) {
            const operation = operations[index];
            if (operation.type !== 'insert') oldCount += 1;
            if (operation.type !== 'delete') newCount += 1;
            lines.push(
                `${operation.type === 'equal' ? ' ' : operation.type === 'delete' ? '-' : '+'}${operation.line}`,
            );
        }
        result.push(
            `@@ -${oldCount === 1 ? oldLine : `${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount}`} +${newCount === 1 ? newLine : `${newCount === 0 ? newLine - 1 : newLine},${newCount}`} @@`,
        );
        result.push(...lines);
    }
    return result;
}

function changeCounts(oldText: string, newText: string): { additions: number; deletions: number } {
    const operations = diffLines(splitLines(oldText), splitLines(newText));
    return {
        additions: operations.filter(operation => operation.type === 'insert').length,
        deletions: operations.filter(operation => operation.type === 'delete').length,
    };
}

async function readSandboxFiles(
    sandbox: SandboxClient,
    limits: CodingChangeLimits,
    signal: AbortSignal | undefined,
): Promise<Map<string, FileContent>> {
    const files = new Map<string, FileContent>();
    let totalBytes = 0;
    let count = 0;

    const walk = async (directory: string): Promise<void> => {
        const listing = await sandbox.list(directory, { maxEntries: limits.maxFiles + 1, signal });
        if (listing.truncated) {
            throw new CodingSessionError('limit', 'Sandbox contains too many files to review');
        }
        for (const entry of listing.entries) {
            if (entry.name === '.git') {
                continue;
            }
            const path = directory ? `${directory}/${entry.name}` : entry.name;
            if (entry.type === 'directory') {
                await walk(path);
                continue;
            }
            if (entry.type !== 'file') {
                throw new CodingSessionError('sandbox', `Unsupported sandbox entry type for ${path}`);
            }
            count += 1;
            if (count > limits.maxFiles) {
                throw new CodingSessionError('limit', 'Sandbox contains too many files to review');
            }
            const bytes = await sandbox.readFile(path, { maxBytes: limits.maxFileBytes, signal });
            totalBytes += bytes.byteLength;
            if (totalBytes > limits.maxTotalBytes) {
                throw new CodingSessionError('limit', 'Sandbox changes exceed the review size limit');
            }
            files.set(path, { path, bytes, sha256: await sha256Hex(bytes) });
        }
    };

    await walk('');
    return files;
}

function pairRenames(
    base: Map<string, FileContent>,
    current: Map<string, FileContent>,
): { oldPath: string; newPath: string }[] {
    const deleted = [...base.keys()].filter(path => !current.has(path)).sort();
    const added = [...current.keys()].filter(path => !base.has(path)).sort();
    const pairs: { oldPath: string; newPath: string }[] = [];
    const used = new Set<string>();
    for (const oldPath of deleted) {
        const oldFile = base.get(oldPath)!;
        const newPath = added.find(path => !used.has(path) && current.get(path)!.sha256 === oldFile.sha256);
        if (newPath) {
            used.add(newPath);
            pairs.push({ oldPath, newPath });
        }
    }
    return pairs;
}

export async function collectCodingChanges(options: CollectCodingChangesOptions): Promise<CodingChangeSet | null> {
    const limits = { ...DEFAULT_CODING_CHANGE_LIMITS, ...options.limits };
    const access = {
        userId: options.session.userId,
        chatId: options.session.chatId,
        repository: options.session.repository,
        sessionId: options.session.sessionId,
    };
    const head = await options.github.getBranchHead(options.session.repository, access, options.baseRef, {
        signal: options.signal,
    });
    if (head.sha.toLowerCase() !== options.baseCommitSha.toLowerCase()) {
        throw new CodingSessionError('stale', 'The base branch changed after the repository was checked out');
    }
    const archive = await options.github.downloadRepository(options.session.repository, access, {
        ref: options.baseCommitSha,
        signal: options.signal,
    });
    if (archive.commitSha && archive.commitSha.toLowerCase() !== options.baseCommitSha.toLowerCase()) {
        throw new CodingSessionError('stale', 'The base commit changed while collecting the diff');
    }

    const base = new Map<string, FileContent>();
    for (const file of archive.files) {
        base.set(file.path, {
            path: file.path,
            bytes: file.content,
            sha256: await sha256Hex(file.content),
        });
    }
    const current = await readSandboxFiles(options.sandbox, limits, options.signal);
    const renamed = pairRenames(base, current);
    const renamedOld = new Set(renamed.map(pair => pair.oldPath));
    const renamedNew = new Map(renamed.map(pair => [pair.newPath, pair.oldPath]));
    const changes: CodingChangeFile[] = [];
    const diffParts: string[] = [];

    for (const path of [...new Set([...base.keys(), ...current.keys()])].sort()) {
        const oldFile = base.get(path);
        const newFile = current.get(path);
        if (oldFile && newFile && oldFile.sha256 === newFile.sha256) {
            continue;
        }
        if (renamedOld.has(path)) {
            const pair = renamed.find(item => item.oldPath === path)!;
            const file = current.get(pair.newPath)!;
            changes.push({
                path: pair.newPath,
                previousPath: path,
                status: 'renamed',
                sha256: file.sha256,
                size: file.bytes.byteLength,
                additions: 0,
                deletions: 0,
                contentBase64: bytesToBase64(file.bytes),
            });
            diffParts.push(
                `diff --git a/${path} b/${pair.newPath}`,
                `similarity index 100%`,
                `rename from ${path}`,
                `rename to ${pair.newPath}`,
            );
            continue;
        }
        if (renamedNew.has(path)) {
            continue;
        }
        const oldText = oldFile ? decoder.decode(oldFile.bytes) : '';
        const newText = newFile ? decoder.decode(newFile.bytes) : '';
        const binary = Boolean((oldFile && isBinary(oldFile.bytes)) || (newFile && isBinary(newFile.bytes)));
        const counts = binary ? { additions: 0, deletions: 0 } : changeCounts(oldText, newText);
        if (oldFile && newFile) {
            changes.push({
                path,
                status: 'modified',
                sha256: newFile.sha256,
                size: newFile.bytes.byteLength,
                ...counts,
                ...(binary ? { binary: true } : {}),
                contentBase64: bytesToBase64(newFile.bytes),
            });
            diffParts.push(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`);
            diffParts.push(
                ...(binary
                    ? ['Binary files differ']
                    : unifiedHunks(diffLines(splitLines(oldText), splitLines(newText)))),
            );
        } else if (newFile) {
            changes.push({
                path,
                status: 'added',
                sha256: newFile.sha256,
                size: newFile.bytes.byteLength,
                ...counts,
                ...(binary ? { binary: true } : {}),
                contentBase64: bytesToBase64(newFile.bytes),
            });
            diffParts.push(`diff --git a/${path} b/${path}`, `new file mode 100644`, `--- /dev/null`, `+++ b/${path}`);
            diffParts.push(...(binary ? ['Binary files differ'] : unifiedHunks(diffLines([], splitLines(newText)))));
        } else if (oldFile) {
            changes.push({
                path,
                status: 'deleted',
                sha256: oldFile.sha256,
                size: oldFile.bytes.byteLength,
                ...counts,
                ...(binary ? { binary: true } : {}),
            });
            diffParts.push(
                `diff --git a/${path} b/${path}`,
                `deleted file mode 100644`,
                `--- a/${path}`,
                `+++ /dev/null`,
            );
            diffParts.push(...(binary ? ['Binary files differ'] : unifiedHunks(diffLines(splitLines(oldText), []))));
        }
    }

    if (changes.length === 0) {
        return null;
    }
    if (changes.length > 500) {
        throw new CodingSessionError('limit', 'The proposed change set has too many files to write safely');
    }
    const diff = `${diffParts.join('\n')}\n`;
    if (encoder.encode(diff).byteLength > limits.maxDiffBytes) {
        throw new CodingSessionError('limit', 'The proposed diff is too large to review safely');
    }
    const canonical = JSON.stringify({
        repository: options.session.repository.toLowerCase(),
        baseRef: options.baseRef,
        baseCommitSha: options.baseCommitSha.toLowerCase(),
        files: changes
            .map(file => ({
                path: file.path,
                previousPath: file.previousPath ?? null,
                status: file.status,
                sha256: file.sha256,
                size: file.size,
                binary: Boolean(file.binary),
            }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        diff,
    });
    const diffHash = await sha256Hex(encoder.encode(canonical));
    const additions = changes.reduce((sum, file) => sum + file.additions, 0);
    const deletions = changes.reduce((sum, file) => sum + file.deletions, 0);
    const counts = new Map<string, number>();
    for (const file of changes) {
        counts.set(file.status, (counts.get(file.status) ?? 0) + 1);
    }
    const summary = [
        `${changes.length} file${changes.length === 1 ? '' : 's'} changed: ${[...counts.entries()]
            .map(([status, count]) => `${count} ${status}`)
            .join(', ')}`,
        `+${additions} -${deletions}`,
        `Diff SHA-256: ${diffHash}`,
    ].join('\n');
    return {
        repository: options.session.repository.toLowerCase(),
        baseRef: options.baseRef,
        baseCommitSha: options.baseCommitSha,
        diffHash,
        diff,
        files: changes,
        summary,
        createdAt: (options.now ?? Date.now)(),
    };
}
