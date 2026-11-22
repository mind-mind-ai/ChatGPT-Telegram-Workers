import type {
    CompletionResult,
    Message,
    ToolCall,
    ToolChoice,
    ToolDefinition,
    ToolResult,
    Usage,
} from '@chatgpt-telegram-workers/ai';
import type { ToolAccessContext, ToolRegistry } from './tools';
import { DEFAULT_MAX_TOOL_RESULT_CHARS, DEFAULT_TOOL_TIMEOUT_MS, truncateToolResult } from './tools';
import { AgentTimeoutError, createAbortError, raceWithSignal } from './errors';

export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS = 100_000;

export interface AgentLLMRequest {
    messages: Message[];
    tools: ToolDefinition[];
    toolChoice: ToolChoice;
    /** Overrides the configured chat system prompt for this run. */
    system?: string;
    signal?: AbortSignal;
}

export type AgentLLMComplete = (request: AgentLLMRequest) => Promise<CompletionResult>;

export interface AgentRuntimeOptions {
    /** Caller identity and permissions for tool access checks. */
    access?: ToolAccessContext;
    /** Maximum number of LLM calls; at least 1. Defaults to 8. */
    maxSteps?: number;
    /** Overall agent run timeout in milliseconds; <= 0 disables it. */
    timeoutMs?: number;
    /** Per-tool timeout in milliseconds; <= 0 disables it. */
    toolTimeoutMs?: number;
    /** Maximum length of one tool result; <= 0 disables the limit. */
    maxToolResultChars?: number;
    /** Combined maximum length of all tool results; <= 0 disables the limit. */
    maxTotalToolResultChars?: number;
    /** Cancellation signal; aborts both LLM calls and tools. */
    signal?: AbortSignal;
    /** Defaults to `auto`. */
    toolChoice?: ToolChoice;
    /** Optional system prompt override; normal chat leaves this unset. */
    system?: string;
}

export type CompleteWithToolsOptions = AgentRuntimeOptions;

export interface AgentRunResult {
    text: string;
    messages: Message[];
    /** Number of LLM calls made. */
    steps: number;
    /** All tool calls requested by the model. */
    toolCalls: ToolCall[];
    /**
     * Tool results. When max steps is reached, unexecuted calls get a synthetic
     * error result so the message sequence stays valid for the protocols.
     */
    toolResults: ToolResult[];
    usage?: Usage;
    stopReason: 'complete' | 'max-steps';
}

interface AbortScope {
    signal: AbortSignal;
    timedOut: () => boolean;
    clear: () => void;
}

function createAbortScope(parent: AbortSignal | undefined, timeoutMs: number): AbortScope {
    const controller = new AbortController();
    let timedOut = false;

    const abortFromParent = () => controller.abort(parent?.reason);
    if (parent) {
        if (parent.aborted) {
            controller.abort(parent.reason);
        } else {
            parent.addEventListener('abort', abortFromParent, { once: true });
        }
    }

    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  controller.abort(new AgentTimeoutError(`Agent run timed out after ${timeoutMs} ms`));
              }, timeoutMs)
            : undefined;

    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        clear: () => {
            if (timer) {
                clearTimeout(timer);
            }
            parent?.removeEventListener('abort', abortFromParent);
        },
    };
}

function throwIfAborted(scope: AbortScope, parent: AbortSignal | undefined): void {
    if (scope.timedOut()) {
        throw new AgentTimeoutError('Agent run timed out');
    }
    if (parent?.aborted) {
        throw createAbortError('Agent run aborted', parent.reason);
    }
    if (scope.signal.aborted) {
        throw createAbortError('Agent run aborted', scope.signal.reason);
    }
}

function addUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
    if (!next) {
        return total;
    }
    const merged: Usage = { ...total };
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
        const value = next[key];
        if (value !== undefined) {
            merged[key] = (merged[key] ?? 0) + value;
        }
    }
    return Object.keys(merged).length ? merged : undefined;
}

function applyTotalResultLimit(content: string, maxTotalChars: number, usedChars: number): string {
    if (!(maxTotalChars > 0)) {
        return content;
    }
    const remaining = maxTotalChars - usedChars;
    if (remaining <= 0) {
        return `[tool result omitted: total tool result limit (${maxTotalChars} characters) reached]`;
    }
    return content.length <= remaining ? content : truncateToolResult(content, remaining);
}

/**
 * Provider-agnostic agent loop:
 * LLM -> tool calls -> tool execution -> results back to the LLM -> final answer.
 */
export class AgentRuntime {
    constructor(private readonly complete: AgentLLMComplete) {}

    async run(messages: Message[], tools: ToolRegistry, options: AgentRuntimeOptions = {}): Promise<AgentRunResult> {
        const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
        if (!Number.isInteger(maxSteps) || maxSteps < 1) {
            throw new RangeError('maxSteps must be a positive integer');
        }

        const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
        const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
        const maxTotalToolResultChars = options.maxTotalToolResultChars ?? DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS;
        const toolChoice = options.toolChoice ?? 'auto';
        const access = options.access ?? {};
        const scope = createAbortScope(options.signal, options.timeoutMs ?? 0);

        const conversation = [...messages];
        const toolCalls: ToolCall[] = [];
        const toolResults: ToolResult[] = [];
        let usage: Usage | undefined;
        let lastText = '';
        let totalToolResultChars = 0;

        try {
            for (let step = 0; step < maxSteps; step++) {
                throwIfAborted(scope, options.signal);

                const response = await raceWithSignal(
                    this.complete({
                        // Snapshot: the LLM request must not see messages appended later.
                        messages: [...conversation],
                        tools: tools.definitions(access),
                        toolChoice,
                        ...(options.system ? { system: options.system } : {}),
                        signal: scope.signal,
                    }),
                    scope.signal,
                );

                usage = addUsage(usage, response.usage);
                lastText = response.text;
                const calls = response.toolCalls ?? [];

                if (calls.length === 0) {
                    conversation.push({ role: 'assistant', content: response.text });
                    return {
                        text: response.text,
                        messages: conversation,
                        steps: step + 1,
                        toolCalls,
                        toolResults,
                        usage,
                        stopReason: 'complete',
                    };
                }

                conversation.push({ role: 'assistant', content: response.text, toolCalls: calls });
                toolCalls.push(...calls);

                // Do not execute tools on the last allowed LLM call, because their results
                // cannot be fed back to the model. Add synthetic error results so the
                // message sequence stays valid for the protocols.
                if (step + 1 >= maxSteps) {
                    for (const call of calls) {
                        const finalResult: ToolResult = {
                            toolCallId: call.id,
                            content: `Tool not executed: maximum steps (${maxSteps}) reached`,
                            isError: true,
                        };
                        toolResults.push(finalResult);
                        conversation.push({
                            role: 'tool',
                            toolCallId: finalResult.toolCallId,
                            name: call.name,
                            content: finalResult.content,
                            isError: true,
                        });
                    }
                    return {
                        text: lastText,
                        messages: conversation,
                        steps: step + 1,
                        toolCalls,
                        toolResults,
                        usage,
                        stopReason: 'max-steps',
                    };
                }

                for (const call of calls) {
                    throwIfAborted(scope, options.signal);

                    const result = await tools.execute(call, access, {
                        signal: scope.signal,
                        timeoutMs: toolTimeoutMs,
                        maxResultChars: maxToolResultChars,
                    });

                    const content = applyTotalResultLimit(
                        result.content,
                        maxTotalToolResultChars,
                        totalToolResultChars,
                    );
                    totalToolResultChars += content.length;

                    const finalResult: ToolResult = {
                        toolCallId: result.toolCallId,
                        content,
                        ...(result.isError ? { isError: true } : {}),
                    };
                    toolResults.push(finalResult);
                    conversation.push({
                        role: 'tool',
                        toolCallId: finalResult.toolCallId,
                        name: call.name,
                        content: finalResult.content,
                        ...(finalResult.isError ? { isError: true } : {}),
                    });
                }
            }

            return {
                text: lastText,
                messages: conversation,
                steps: maxSteps,
                toolCalls,
                toolResults,
                usage,
                stopReason: 'max-steps',
            };
        } catch (error) {
            if (scope.timedOut()) {
                if (error instanceof AgentTimeoutError) {
                    throw error;
                }
                throw new AgentTimeoutError('Agent run timed out', error);
            }
            if (options.signal?.aborted) {
                throw createAbortError('Agent run aborted', options.signal.reason);
            }
            throw error;
        } finally {
            scope.clear();
        }
    }
}
