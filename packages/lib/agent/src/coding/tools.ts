import {
    DEFAULT_EXEC_TIMEOUT_MS,
    DEFAULT_MAX_OUTPUT_BYTES,
    MAX_COMMAND_LENGTH,
    MAX_EXEC_TIMEOUT_MS,
    MAX_MAX_OUTPUT_BYTES,
    SandboxError,
    clampInt,
    normalizeRelativePath,
    type SandboxClient,
    type SandboxExecResult,
    type SandboxListResult,
} from '@chatgpt-telegram-workers/sandbox';
import type { Tool, ToolAccessContext, ToolHandlerResult, ToolRegistry } from '../tools';
import {
    CODING_TOOL_PERMISSION,
    DEFAULT_CODING_LIST_ENTRIES,
    DEFAULT_CODING_READ_BYTES,
    MAX_CODING_EDIT_BYTES,
    MAX_CODING_LIST_ENTRIES,
    MAX_CODING_READ_BYTES,
    MAX_CODING_WRITE_BYTES,
} from './constants';
import { ownershipError } from './ownership';

class CodingArgumentError extends Error {
    readonly name = 'CodingArgumentError';
}

export interface CodingToolsOptions {
    sandbox: SandboxClient;
    /** Permission required by all coding tools. Defaults to `coding`. */
    permission?: string;
    requiredPermissions?: readonly string[];
    defaultShellTimeoutMs?: number;
    defaultReadBytes?: number;
    defaultListEntries?: number;
}

function normalizeOptions(input: CodingToolsOptions | SandboxClient): CodingToolsOptions {
    return 'workspace' in input ? { sandbox: input } : input;
}

function requireString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') {
        throw new CodingArgumentError(`${key} must be a string`);
    }
    return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new CodingArgumentError(`${key} must be a string`);
    }
    return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
    const value = args[key];
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'boolean') {
        throw new CodingArgumentError(`${key} must be a boolean`);
    }
    return value;
}

function pathArgument(args: Record<string, unknown>, key: string, required = true): string {
    const value = optionalString(args, key);
    if (value === undefined) {
        if (required) {
            throw new CodingArgumentError(`${key} is required`);
        }
        return '';
    }
    return normalizeRelativePath(value, key);
}

function nonEmptyPathArgument(args: Record<string, unknown>, key: string): string {
    const path = pathArgument(args, key);
    if (!path) {
        throw new CodingArgumentError(`${key} must not be the workspace root`);
    }
    return path;
}

function errorMessage(error: unknown): string {
    if (error instanceof CodingArgumentError) {
        return error.message;
    }
    if (error instanceof SandboxError) {
        return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatExecResult(result: SandboxExecResult): ToolHandlerResult {
    const lines = [
        `Command: ${result.command}`,
        `Cwd: ${result.cwd}`,
        `Exit code: ${result.exitCode}`,
        `Duration: ${result.durationMs} ms`,
        `Truncated: ${result.truncated ? 'yes' : 'no'}`,
        '',
        'stdout:',
        result.stdout || '(empty)',
        '',
        'stderr:',
        result.stderr || '(empty)',
    ];
    return { content: lines.join('\n'), isError: result.exitCode !== 0 };
}

function formatListResult(result: SandboxListResult): string {
    const lines = [`Directory: ${result.path || '.'}`];
    if (result.entries.length === 0) {
        lines.push('(empty)');
    } else {
        for (const entry of result.entries) {
            lines.push(`- ${entry.type}: ${entry.name}`);
        }
    }
    if (result.truncated) {
        lines.push('(list truncated at the entry limit)');
    }
    return lines.join('\n');
}

function formatFileContent(path: string, bytes: Uint8Array): string {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return `File: ${path} (${bytes.byteLength} bytes)\n\n${text}`;
}

export function createCodingTools(input: CodingToolsOptions | SandboxClient): Tool[] {
    const options = normalizeOptions(input);
    const sandbox = options.sandbox;
    const permission = options.permission ?? CODING_TOOL_PERMISSION;
    const requiredPermissions = options.requiredPermissions ?? (permission ? [permission] : []);
    const defaultShellTimeoutMs = clampInt(
        options.defaultShellTimeoutMs,
        1,
        MAX_EXEC_TIMEOUT_MS,
        DEFAULT_EXEC_TIMEOUT_MS,
    );
    const defaultReadBytes = clampInt(options.defaultReadBytes, 1, MAX_CODING_READ_BYTES, DEFAULT_CODING_READ_BYTES);
    const defaultListEntries = clampInt(
        options.defaultListEntries,
        1,
        MAX_CODING_LIST_ENTRIES,
        DEFAULT_CODING_LIST_ENTRIES,
    );

    const canUse = (context: ToolAccessContext): boolean | string => {
        const hasScope = Boolean(
            context.userId ||
            context.repository ||
            context.sessionId ||
            context.metadata?.userId ||
            context.metadata?.repository ||
            context.metadata?.sessionId,
        );
        return hasScope ? (ownershipError(sandbox.workspace, context) ?? true) : true;
    };

    const run = async (
        context: Parameters<Tool['execute']>[1],
        action: () => Promise<ToolHandlerResult>,
    ): Promise<ToolHandlerResult> => {
        const denial = ownershipError(sandbox.workspace, context.access);
        if (denial) {
            return { content: `Coding tool denied: ${denial}`, isError: true };
        }
        try {
            return await action();
        } catch (error) {
            if (context.signal.aborted) {
                throw error;
            }
            return { content: `Coding tool failed: ${errorMessage(error)}`, isError: true };
        }
    };

    const exec = (
        command: string,
        cwd: string,
        signal: AbortSignal,
        timeoutMs: number,
        maxOutputBytes: number,
    ): Promise<SandboxExecResult> => sandbox.exec(command, { cwd, signal, timeoutMs, maxOutputBytes });

    return [
        {
            name: 'shell_exec',
            description:
                'Run a shell command inside the sandbox container. The command cannot run on the host. Use it for builds, tests, and git operations.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        minLength: 1,
                        maxLength: MAX_COMMAND_LENGTH,
                        description: 'Shell command to execute inside the sandbox.',
                    },
                    cwd: {
                        type: 'string',
                        description: 'Relative working directory inside the workspace.',
                    },
                    timeout_ms: {
                        type: 'integer',
                        minimum: 1,
                        maximum: MAX_EXEC_TIMEOUT_MS,
                        description: `Command timeout in milliseconds (default ${defaultShellTimeoutMs}).`,
                    },
                    max_output_bytes: {
                        type: 'integer',
                        minimum: 1,
                        maximum: MAX_MAX_OUTPUT_BYTES,
                        description: 'Maximum bytes captured from each output stream.',
                    },
                },
                required: ['command'],
                additionalProperties: false,
            },
            requiredPermissions,
            canUse,
            execute: (args, context) =>
                run(context, async () => {
                    const command = requireString(args, 'command').trim();
                    if (!command) {
                        throw new CodingArgumentError('command must not be empty');
                    }
                    if (command.length > MAX_COMMAND_LENGTH) {
                        throw new CodingArgumentError(`command is too long (max ${MAX_COMMAND_LENGTH} characters)`);
                    }
                    const cwd = pathArgument(args, 'cwd', false);
                    const timeoutMs = clampInt(args.timeout_ms, 1, MAX_EXEC_TIMEOUT_MS, defaultShellTimeoutMs);
                    const maxOutputBytes = clampInt(
                        args.max_output_bytes,
                        1,
                        MAX_MAX_OUTPUT_BYTES,
                        DEFAULT_MAX_OUTPUT_BYTES,
                    );
                    return formatExecResult(await exec(command, cwd, context.signal, timeoutMs, maxOutputBytes));
                }),
        },
        {
            name: 'fs_list',
            description: 'List files and directories inside the sandbox workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative directory path (default: workspace root).' },
                    max_entries: {
                        type: 'integer',
                        minimum: 1,
                        maximum: MAX_CODING_LIST_ENTRIES,
                        description: `Maximum entries to return (default ${defaultListEntries}).`,
                    },
                },
                additionalProperties: false,
            },
            requiredPermissions,
            canUse,
            execute: (args, context) =>
                run(context, async () => {
                    const path = pathArgument(args, 'path', false);
                    const maxEntries = clampInt(args.max_entries, 1, MAX_CODING_LIST_ENTRIES, defaultListEntries);
                    return formatListResult(await sandbox.list(path, { maxEntries, signal: context.signal }));
                }),
        },
        {
            name: 'fs_read',
            description: 'Read a UTF-8 text file from the sandbox workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative file path inside the workspace.' },
                    max_bytes: {
                        type: 'integer',
                        minimum: 1,
                        maximum: MAX_CODING_READ_BYTES,
                        description: `Maximum file size to read (default ${defaultReadBytes}).`,
                    },
                },
                required: ['path'],
                additionalProperties: false,
            },
            requiredPermissions,
            canUse,
            execute: (args, context) =>
                run(context, async () => {
                    const path = nonEmptyPathArgument(args, 'path');
                    const maxBytes = clampInt(args.max_bytes, 1, MAX_CODING_READ_BYTES, defaultReadBytes);
                    const bytes = await sandbox.readFile(path, { maxBytes, signal: context.signal });
                    return formatFileContent(path, bytes);
                }),
        },
        {
            name: 'fs_write',
            description: 'Create or overwrite a UTF-8 text file inside the sandbox workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative file path inside the workspace.' },
                    content: { type: 'string', description: 'Complete new file content.' },
                },
                required: ['path', 'content'],
                additionalProperties: false,
            },
            requiredPermissions,
            canUse,
            execute: (args, context) =>
                run(context, async () => {
                    const path = nonEmptyPathArgument(args, 'path');
                    const content = requireString(args, 'content');
                    const bytes = new TextEncoder().encode(content).byteLength;
                    if (bytes > MAX_CODING_WRITE_BYTES) {
                        throw new CodingArgumentError(`content is too large (max ${MAX_CODING_WRITE_BYTES} bytes)`);
                    }
                    await sandbox.writeFile(path, content, { signal: context.signal });
                    return `Wrote ${bytes} bytes to ${path}.`;
                }),
        },
        {
            name: 'fs_edit',
            description: 'Replace text in an existing workspace file. Fails when the old text is not found.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative file path inside the workspace.' },
                    old_text: { type: 'string', minLength: 1, description: 'Exact text to replace.' },
                    new_text: { type: 'string', description: 'Replacement text.' },
                    replace_all: {
                        type: 'boolean',
                        description: 'Replace every occurrence instead of only the first one.',
                    },
                },
                required: ['path', 'old_text', 'new_text'],
                additionalProperties: false,
            },
            requiredPermissions,
            canUse,
            execute: (args, context) =>
                run(context, async () => {
                    const path = nonEmptyPathArgument(args, 'path');
                    const oldText = requireString(args, 'old_text');
                    if (!oldText) {
                        throw new CodingArgumentError('old_text must not be empty');
                    }
                    const newText = requireString(args, 'new_text');
                    const replaceAll = optionalBoolean(args, 'replace_all');
                    const bytes = await sandbox.readFile(path, {
                        maxBytes: MAX_CODING_EDIT_BYTES,
                        signal: context.signal,
                    });
                    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                    const occurrences = text.split(oldText).length - 1;
                    if (occurrences === 0) {
                        return { content: `Text not found in ${path}.`, isError: true };
                    }
                    const updated = replaceAll
                        ? text.split(oldText).join(newText)
                        : text.slice(0, text.indexOf(oldText)) +
                          newText +
                          text.slice(text.indexOf(oldText) + oldText.length);
                    if (updated === text) {
                        return `No changes were needed in ${path}.`;
                    }
                    await sandbox.writeFile(path, updated, { signal: context.signal });
                    return `Updated ${path} (${replaceAll ? occurrences : 1} replacement${replaceAll && occurrences !== 1 ? 's' : ''}).`;
                }),
        },
        {
            name: 'fs_rename',
            description: 'Rename or move a file or directory inside the sandbox workspace.',
            parameters: {
                type: 'object',
                properties: {
                    from: { type: 'string', description: 'Relative source path.' },
                    to: { type: 'string', description: 'Relative destination path.' },
                },
                required: ['from', 'to'],
                additionalProperties: false,
            },
            requiredPermissions,
            canUse,
            execute: (args, context) =>
                run(context, async () => {
                    const from = nonEmptyPathArgument(args, 'from');
                    const to = nonEmptyPathArgument(args, 'to');
                    await sandbox.rename(from, to, { signal: context.signal });
                    return `Renamed ${from} to ${to}.`;
                }),
        },
        {
            name: 'fs_delete',
            description: 'Delete a file or directory inside the sandbox workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to delete.' },
                    recursive: { type: 'boolean', description: 'Delete a directory tree.' },
                    force: { type: 'boolean', description: 'Ignore a missing path.' },
                },
                required: ['path'],
                additionalProperties: false,
            },
            requiredPermissions,
            canUse,
            execute: (args, context) =>
                run(context, async () => {
                    const path = nonEmptyPathArgument(args, 'path');
                    const recursive = optionalBoolean(args, 'recursive');
                    const force = optionalBoolean(args, 'force');
                    await sandbox.remove(path, { recursive, force, signal: context.signal });
                    return `Deleted ${path}.`;
                }),
        },
        {
            name: 'git_status',
            description: 'Show git working-tree status inside the sandbox workspace.',
            parameters: {
                type: 'object',
                properties: {
                    cwd: { type: 'string', description: 'Relative working directory (default: workspace root).' },
                },
                additionalProperties: false,
            },
            requiredPermissions,
            canUse,
            execute: (args, context) =>
                run(context, async () => {
                    const cwd = pathArgument(args, 'cwd', false);
                    const result = await exec(
                        'git status --short --branch',
                        cwd,
                        context.signal,
                        defaultShellTimeoutMs,
                        DEFAULT_MAX_OUTPUT_BYTES,
                    );
                    return formatExecResult(result);
                }),
        },
        {
            name: 'git_diff',
            description: 'Show a git diff inside the sandbox workspace.',
            parameters: {
                type: 'object',
                properties: {
                    cwd: { type: 'string', description: 'Relative working directory (default: workspace root).' },
                    path: { type: 'string', description: 'Optional relative path to diff.' },
                    staged: { type: 'boolean', description: 'Show the staged diff instead of the working tree.' },
                },
                additionalProperties: false,
            },
            requiredPermissions,
            canUse,
            execute: (args, context) =>
                run(context, async () => {
                    const cwd = pathArgument(args, 'cwd', false);
                    const path = pathArgument(args, 'path', false);
                    const staged = optionalBoolean(args, 'staged');
                    const command = ['git', 'diff', ...(staged ? ['--cached'] : [])];
                    if (path) {
                        command.push('--', shellQuote(path));
                    }
                    const result = await exec(
                        command.join(' '),
                        cwd,
                        context.signal,
                        defaultShellTimeoutMs,
                        DEFAULT_MAX_OUTPUT_BYTES,
                    );
                    return formatExecResult(result);
                }),
        },
    ];
}

export function registerCodingTools(registry: ToolRegistry, input: CodingToolsOptions | SandboxClient): ToolRegistry {
    registry.registerAll(createCodingTools(input));
    return registry;
}
