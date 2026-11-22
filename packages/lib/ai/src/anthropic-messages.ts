import type { SSEMessage } from './sse';
import type {
    ClientConfig,
    CompletionOptions,
    CompletionResult,
    LLMClient,
    Message,
    Part,
    Protocol,
    SSEParseResult,
    ToolCall,
    ToolChoice,
    Usage,
} from './types';
import { assertNoToolsInStream, contentToText, extractSystem, parseToolArguments, sumTokens } from './common';
import { joinUrl, parseJSONSync, postJSON } from './fetch';
import { adaptMessageImages, DEFAULT_IMAGE_MIME_TYPE, resolveImage } from './image';
import { imageAdaptMode } from './protocols';
import { iterSSEMessages, isDoneSentinel } from './sse';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

function toUsage(usage: any): Usage | undefined {
    if (!usage) {
        return undefined;
    }
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    return {
        inputTokens,
        outputTokens,
        totalTokens: sumTokens(inputTokens, outputTokens),
    };
}

function renderPart(part: Part): any | null {
    if (part.type === 'text') {
        return { type: 'text', text: part.text };
    }
    const image = resolveImage(part.image, part.mimeType || DEFAULT_IMAGE_MIME_TYPE);
    // anthropic 图片始终内联为 base64(见 protocols.ts 的 inline 能力),此处不会有 url 分支
    if (image.base64) {
        return {
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType || DEFAULT_IMAGE_MIME_TYPE, data: image.base64 },
        };
    }
    return null;
}

function renderContent(content: Message['content']): string | any[] {
    if (typeof content === 'string') {
        return content;
    }
    return content.map(renderPart).filter(part => part !== null);
}

function renderToolUse(call: ToolCall): any {
    return {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: parseToolArguments(call.arguments),
    };
}

function renderAnthropicMessage(message: Message): any {
    if (message.role === 'assistant' && message.toolCalls?.length) {
        const parts: any[] =
            typeof message.content === 'string'
                ? message.content
                    ? [{ type: 'text', text: message.content }]
                    : []
                : message.content.map(renderPart).filter(part => part !== null);
        parts.push(...message.toolCalls.map(renderToolUse));
        return { role: 'assistant', content: parts };
    }
    return { role: message.role, content: renderContent(message.content) };
}

function renderToolResult(message: Message): any {
    return {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: contentToText(message.content),
        ...(message.isError ? { is_error: true } : {}),
    };
}

function appendAnthropicMessage(messages: any[], message: Message): void {
    if (message.role === 'tool') {
        const block = renderToolResult(message);
        const last = messages.at(-1);
        // Anthropic odottaa työkalutulokset user-viestin sisällä;yhdistä peräkkäiset.
        if (
            last?.role === 'user' &&
            Array.isArray(last.content) &&
            last.content.every((part: any) => part.type === 'tool_result')
        ) {
            last.content.push(block);
            return;
        }
        messages.push({ role: 'user', content: [block] });
        return;
    }
    messages.push(renderAnthropicMessage(message));
}

function renderToolChoice(choice: ToolChoice): unknown {
    if (choice === 'required') {
        return { type: 'any' };
    }
    if (typeof choice === 'string') {
        return { type: choice };
    }
    return { type: 'tool', name: choice.name };
}

export function buildAnthropicMessagesBody(options: CompletionOptions, stream: boolean): any {
    const { system, messages } = extractSystem(options);
    const body: any = {
        ...options.extra,
        model: options.model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options.stop ? { stop_sequences: Array.isArray(options.stop) ? options.stop : [options.stop] } : {}),
        ...(stream ? { stream: true } : {}),
        messages: [],
    };
    for (const message of messages) {
        appendAnthropicMessage(body.messages, message);
    }
    if (options.tools?.length) {
        body.tools = options.tools.map(tool => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            input_schema: tool.parameters ?? { type: 'object', properties: {} },
        }));
        // tool_choice on validi vain, kun työkaluja on mukana
        if (options.toolChoice !== undefined) {
            body.tool_choice = renderToolChoice(options.toolChoice);
        }
    }
    return body;
}

export function parseAnthropicMessagesResponse(data: any): CompletionResult {
    if (data?.error) {
        throw new Error(data.error.message || 'Unknown error');
    }
    const content = Array.isArray(data?.content) ? data.content : [];
    const toolCalls: ToolCall[] = content
        .filter((block: any) => block?.type === 'tool_use')
        .map((block: any) => ({
            id: block.id ?? '',
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
        }));
    return {
        text: contentToText(content),
        usage: toUsage(data?.usage),
        stopReason: data?.stop_reason ?? null,
        ...(toolCalls.length ? { toolCalls } : {}),
    };
}

export function parseAnthropicMessagesSSE(sse: SSEMessage): SSEParseResult {
    if (isDoneSentinel(sse.data)) {
        return { finish: true };
    }
    const payload = parseJSONSync(sse.data);
    if (!payload) {
        return {};
    }
    switch (payload.type) {
        case 'content_block_delta':
            if (payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string') {
                return { delta: payload.delta.text };
            }
            return {};
        case 'message_stop':
            return { finish: true };
        case 'error':
            return { error: payload.error?.message || 'Unknown error' };
        default:
            return {};
    }
}

export class AnthropicMessagesClient implements LLMClient {
    readonly protocol: Protocol = 'anthropic-messages';
    private readonly config: ClientConfig;

    constructor(config: ClientConfig = {}) {
        this.config = config;
    }

    private endpoint(): string {
        return joinUrl(this.config.baseUrl || DEFAULT_BASE_URL, '/messages');
    }

    private headers(options: CompletionOptions, stream: boolean): Record<string, string> {
        return {
            'content-type': 'application/json',
            ...(stream ? { accept: 'text/event-stream' } : {}),
            ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}),
            'anthropic-version': ANTHROPIC_VERSION,
            ...this.config.headers,
            ...options.headers,
        };
    }

    private async request(options: CompletionOptions, stream: boolean): Promise<Response> {
        const mode = imageAdaptMode(this.protocol, this.config.imageTransfer);
        const adapted = { ...options, messages: await adaptMessageImages(options.messages, mode, this.config.fetch) };
        return postJSON(this.endpoint(), {
            headers: this.headers(options, stream),
            body: buildAnthropicMessagesBody(adapted, stream),
            signal: options.signal,
            fetch: this.config.fetch,
        });
    }

    async complete(options: CompletionOptions): Promise<CompletionResult> {
        const response = await this.request(options, false);
        return parseAnthropicMessagesResponse(await response.json());
    }

    async *stream(options: CompletionOptions): AsyncIterable<string> {
        assertNoToolsInStream(options);
        const response = await this.request(options, true);
        for await (const sse of iterSSEMessages(response)) {
            const { delta, finish, error } = parseAnthropicMessagesSSE(sse);
            if (error) {
                throw new Error(error);
            }
            if (finish) {
                return;
            }
            if (delta) {
                yield delta;
            }
        }
    }
}
