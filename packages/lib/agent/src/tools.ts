import type { ToolCall, ToolDefinition, ToolParameters, ToolResult } from '@chatgpt-telegram-workers/ai';
import { createAbortError, isAbortError, raceWithSignal, ToolTimeoutError } from './errors';

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 20_000;

/** Caller identity and permissions used for tool access checks. */
export interface ToolAccessContext {
    userId?: string;
    chatId?: string;
    permissions?: readonly string[];
    /** Admin bypasses `requiredPermissions`, but not the tool's own `canUse` policy. */
    isAdmin?: boolean;
    metadata?: Record<string, unknown>;
}

export type ToolAccessDecision = { allowed: true } | { allowed: false; reason: string };

export type ToolHandlerResult = string | { content: string; isError?: boolean };

export interface ToolExecutionContext {
    toolCallId: string;
    /** Aborted by caller cancellation or the tool timeout. */
    signal: AbortSignal;
    access: ToolAccessContext;
}

export type ToolHandler = (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
) => ToolHandlerResult | Promise<ToolHandlerResult>;

export interface Tool {
    name: string;
    description: string;
    parameters?: ToolParameters;
    /** All of these permissions are required unless the caller is an admin. */
    requiredPermissions?: readonly string[];
    /** Tool-specific check; a string is treated as a denial reason. */
    canUse?: (context: ToolAccessContext) => boolean | string;
    execute: ToolHandler;
}

export interface ToolRegistryOptions {
    /** Maximum length of one tool result; <= 0 disables the limit. */
    maxResultChars?: number;
    /** Default tool timeout; <= 0 disables the timeout. */
    defaultTimeoutMs?: number;
}

export interface ToolExecuteOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxResultChars?: number;
}

type ParsedArguments = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

export function parseToolArguments(raw: string): ParsedArguments {
    if (raw.trim() === '') {
        return { ok: true, value: {} };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, error: 'arguments must be a JSON object' };
        }
        return { ok: true, value: parsed as Record<string, unknown> };
    } catch (error) {
        return { ok: false, error: `invalid JSON: ${errorMessage(error)}` };
    }
}

export function truncateToolResult(content: string, maxChars: number): string {
    if (!(maxChars > 0) || content.length <= maxChars) {
        return content;
    }
    const suffix = `\n...[truncated ${content.length - maxChars} characters]`;
    if (suffix.length >= maxChars) {
        return content.slice(0, maxChars);
    }
    return content.slice(0, maxChars - suffix.length) + suffix;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizeHandlerResult(result: ToolHandlerResult): { content: string; isError?: boolean } {
    if (typeof result === 'string') {
        return { content: result };
    }
    if (result && typeof result.content === 'string') {
        return { content: result.content, ...(result.isError ? { isError: true } : {}) };
    }
    return { content: String(result), isError: true };
}

async function executeWithTimeout(
    tool: Tool,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    timeoutMs: number,
): Promise<ToolHandlerResult> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(context.signal.reason);
    if (context.signal.aborted) {
        controller.abort(context.signal.reason);
    } else {
        context.signal.addEventListener('abort', abortFromParent, { once: true });
    }

    let timedOut = false;
    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  controller.abort(new ToolTimeoutError(`Tool "${tool.name}" timed out after ${timeoutMs} ms`));
              }, timeoutMs)
            : undefined;

    try {
        const execution = Promise.resolve().then(() => {
            if (controller.signal.aborted) {
                throw createAbortError('Tool execution aborted', controller.signal.reason);
            }
            return tool.execute(args, { ...context, signal: controller.signal });
        });
        return await raceWithSignal(execution, controller.signal);
    } catch (error) {
        if (timedOut) {
            throw new ToolTimeoutError(`Tool "${tool.name}" timed out after ${timeoutMs} ms`);
        }
        if (context.signal.aborted) {
            throw createAbortError('Tool execution aborted', context.signal.reason);
        }
        throw error;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
        context.signal.removeEventListener('abort', abortFromParent);
    }
}

/** Registry for tools, access checks and execution. */
export class ToolRegistry {
    private readonly tools = new Map<string, Tool>();
    private readonly maxResultChars: number;
    private readonly defaultTimeoutMs: number;

    constructor(options: ToolRegistryOptions = {}) {
        this.maxResultChars = options.maxResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    }

    get size(): number {
        return this.tools.size;
    }

    register(tool: Tool): this {
        const name = tool.name.trim();
        if (!name) {
            throw new Error('Tool name must not be empty');
        }
        if (this.tools.has(name)) {
            throw new Error(`Tool already registered: ${name}`);
        }
        this.tools.set(name, { ...tool, name });
        return this;
    }

    registerAll(tools: Iterable<Tool>): this {
        for (const tool of tools) {
            this.register(tool);
        }
        return this;
    }

    get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    clear(): void {
        this.tools.clear();
    }

    checkAccess(name: string, context: ToolAccessContext = {}): ToolAccessDecision {
        const tool = this.tools.get(name);
        if (!tool) {
            return { allowed: false, reason: `Unknown tool: ${name}` };
        }
        return this.checkToolAccess(tool, context);
    }

    list(context: ToolAccessContext = {}): Tool[] {
        return [...this.tools.values()].filter(tool => this.checkToolAccess(tool, context).allowed);
    }

    definitions(context: ToolAccessContext = {}): ToolDefinition[] {
        return this.list(context).map(tool => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.parameters ? { parameters: tool.parameters } : {}),
        }));
    }

    async execute(
        call: ToolCall,
        context: ToolAccessContext = {},
        options: ToolExecuteOptions = {},
    ): Promise<ToolResult> {
        if (options.signal?.aborted) {
            throw createAbortError('Tool execution aborted', options.signal.reason);
        }
        const maxChars = options.maxResultChars ?? this.maxResultChars;
        const tool = this.tools.get(call.name);
        if (!tool) {
            return this.errorResult(call, `Unknown tool: ${call.name}`, maxChars);
        }

        const access = this.checkToolAccess(tool, context);
        if (!access.allowed) {
            return this.errorResult(call, `Tool "${call.name}" is not permitted: ${access.reason}`, maxChars);
        }

        const parsed = parseToolArguments(call.arguments);
        if (!parsed.ok) {
            return this.errorResult(call, `Invalid arguments for tool "${call.name}": ${parsed.error}`, maxChars);
        }

        const signal = options.signal ?? new AbortController().signal;
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

        try {
            const raw = await executeWithTimeout(
                tool,
                parsed.value,
                { toolCallId: call.id, signal, access: context },
                timeoutMs,
            );
            const normalized = normalizeHandlerResult(raw);
            return {
                toolCallId: call.id,
                content: truncateToolResult(normalized.content, maxChars),
                ...(normalized.isError ? { isError: true } : {}),
            };
        } catch (error) {
            if (options.signal?.aborted) {
                throw createAbortError('Tool execution aborted', options.signal.reason);
            }
            if (error instanceof ToolTimeoutError) {
                return this.errorResult(call, error.message, maxChars);
            }
            if (isAbortError(error)) {
                return this.errorResult(call, `Tool "${call.name}" aborted: ${errorMessage(error)}`, maxChars);
            }
            return this.errorResult(call, `Tool "${call.name}" failed: ${errorMessage(error)}`, maxChars);
        }
    }

    private checkToolAccess(tool: Tool, context: ToolAccessContext): ToolAccessDecision {
        if (!context.isAdmin && tool.requiredPermissions?.length) {
            const granted = new Set(context.permissions ?? []);
            const missing = tool.requiredPermissions.filter(permission => !granted.has(permission));
            if (missing.length) {
                return { allowed: false, reason: `missing permission(s): ${missing.join(', ')}` };
            }
        }

        if (tool.canUse) {
            try {
                const decision = tool.canUse(context);
                if (decision === false) {
                    return { allowed: false, reason: 'access denied by tool policy' };
                }
                if (typeof decision === 'string') {
                    return { allowed: false, reason: decision || 'access denied by tool policy' };
                }
            } catch (error) {
                return { allowed: false, reason: `access check failed: ${errorMessage(error)}` };
            }
        }

        return { allowed: true };
    }

    private errorResult(call: ToolCall, content: string, maxChars: number): ToolResult {
        return { toolCallId: call.id, content: truncateToolResult(content, maxChars), isError: true };
    }
}
