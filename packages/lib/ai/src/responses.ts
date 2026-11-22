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
import { assertNoToolsInStream, contentToText, extractSystem, sumTokens } from './common';
import { joinUrl, parseJSONSync, postJSON } from './fetch';
import { adaptMessageImages, DEFAULT_IMAGE_MIME_TYPE, resolveImage, toDataURI } from './image';
import { imageAdaptMode } from './protocols';
import { iterSSEMessages, isDoneSentinel } from './sse';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function toUsage(usage: any): Usage | undefined {
    if (!usage) {
        return undefined;
    }
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    return {
        inputTokens,
        outputTokens,
        totalTokens: usage.total_tokens ?? sumTokens(inputTokens, outputTokens),
    };
}

function textPartType(role: Message['role']): 'input_text' | 'output_text' {
    return role === 'assistant' ? 'output_text' : 'input_text';
}

function renderPart(part: Part, role: Message['role']): any | null {
    if (part.type === 'text') {
        return { type: textPartType(role), text: part.text };
    }
    const image = resolveImage(part.image, part.mimeType || DEFAULT_IMAGE_MIME_TYPE);
    if (image.base64) {
        return { type: 'input_image', image_url: toDataURI(image.base64, image.mimeType || DEFAULT_IMAGE_MIME_TYPE) };
    }
    if (image.url) {
        return { type: 'input_image', image_url: image.url };
    }
    return null;
}

function renderContent(message: Message): any[] {
    if (typeof message.content === 'string') {
        return [{ type: textPartType(message.role), text: message.content }];
    }
    return message.content.map(part => renderPart(part, message.role)).filter(part => part !== null);
}

function buildInput(messages: Message[]): any[] {
    const input: any[] = [];
    for (const message of messages) {
        if (message.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: message.toolCallId,
                output: contentToText(message.content),
            });
            continue;
        }
        if (message.role === 'assistant' && message.toolCalls?.length) {
            const hasContent =
                typeof message.content === 'string' ? message.content.length > 0 : message.content.length > 0;
            if (hasContent) {
                const content = renderContent(message);
                if (content.length) {
                    input.push({ role: 'assistant', content });
                }
            }
            for (const call of message.toolCalls) {
                input.push({
                    type: 'function_call',
                    call_id: call.id,
                    name: call.name,
                    arguments: call.arguments,
                });
            }
            continue;
        }
        input.push({ role: message.role, content: renderContent(message) });
    }
    return input;
}

function renderToolChoice(choice: ToolChoice): unknown {
    if (typeof choice === 'string') {
        return choice;
    }
    return { type: 'function', name: choice.name };
}

export function buildResponsesBody(options: CompletionOptions, stream: boolean): any {
    const { system, messages } = extractSystem(options);
    const body: any = {
        ...options.extra,
        model: options.model,
        ...(system ? { instructions: system } : {}),
        ...(stream ? { stream: true } : {}),
        ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.topP !== undefined ? { top_p: options.topP } : {}),
        input: buildInput(messages),
    };
    if (options.tools?.length) {
        body.tools = options.tools.map(tool => ({
            type: 'function',
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.parameters ? { parameters: tool.parameters } : {}),
        }));
        // tool_choice on validi vain, kun työkaluja on mukana
        if (options.toolChoice !== undefined) {
            body.tool_choice = renderToolChoice(options.toolChoice);
        }
    }
    return body;
}

export function parseResponsesResponse(data: any): CompletionResult {
    if (data?.error) {
        throw new Error(data.error.message || 'Unknown error');
    }
    const output = Array.isArray(data?.output) ? data.output : [];
    const text = output
        .flatMap((item: any) => item?.content || [])
        .filter((item: any) => item?.type === 'output_text')
        .map((item: any) => item.text ?? '')
        .join('');
    const toolCalls: ToolCall[] = output
        .filter((item: any) => item?.type === 'function_call')
        .map((item: any) => ({
            id: item.call_id ?? item.id ?? '',
            name: item.name ?? '',
            arguments: item.arguments ?? '{}',
        }));
    const incomplete = data?.incomplete_details?.reason;
    return {
        text,
        usage: toUsage(data?.usage),
        stopReason: incomplete ?? (data?.status === 'completed' ? 'stop' : null),
        ...(toolCalls.length ? { toolCalls } : {}),
    };
}

export function parseResponsesSSE(sse: SSEMessage): SSEParseResult {
    if (isDoneSentinel(sse.data)) {
        return { finish: true };
    }
    const payload = parseJSONSync(sse.data);
    if (!payload) {
        return {};
    }
    switch (payload.type || sse.event) {
        case 'response.output_text.delta':
            return typeof payload.delta === 'string' ? { delta: payload.delta } : {};
        case 'response.completed':
        case 'response.incomplete':
            return { finish: true };
        case 'response.failed':
            return { error: payload.response?.error?.message || 'Response failed' };
        case 'error':
            return { error: payload.message || 'Unknown error' };
        default:
            return {};
    }
}

export class ResponsesClient implements LLMClient {
    readonly protocol: Protocol = 'responses';
    private readonly config: ClientConfig;

    constructor(config: ClientConfig = {}) {
        this.config = config;
    }

    private endpoint(): string {
        return joinUrl(this.config.baseUrl || DEFAULT_BASE_URL, '/responses');
    }

    private headers(options: CompletionOptions, stream: boolean): Record<string, string> {
        const keyHeader = this.config.apiKeyHeader || 'authorization';
        const apiKeyValue = this.config.apiKeyHeader ? this.config.apiKey : `Bearer ${this.config.apiKey}`;
        return {
            'content-type': 'application/json',
            ...(stream ? { accept: 'text/event-stream' } : {}),
            ...(this.config.apiKey ? { [keyHeader]: apiKeyValue } : {}),
            ...this.config.headers,
            ...options.headers,
        };
    }

    private async request(options: CompletionOptions, stream: boolean): Promise<Response> {
        const mode = imageAdaptMode(this.protocol, this.config.imageTransfer);
        const adapted = { ...options, messages: await adaptMessageImages(options.messages, mode, this.config.fetch) };
        return postJSON(this.endpoint(), {
            headers: this.headers(options, stream),
            body: buildResponsesBody(adapted, stream),
            signal: options.signal,
            fetch: this.config.fetch,
        });
    }

    async complete(options: CompletionOptions): Promise<CompletionResult> {
        const response = await this.request(options, false);
        return parseResponsesResponse(await response.json());
    }

    async *stream(options: CompletionOptions): AsyncIterable<string> {
        assertNoToolsInStream(options);
        const response = await this.request(options, true);
        for await (const sse of iterSSEMessages(response)) {
            const { delta, finish, error } = parseResponsesSSE(sse);
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
