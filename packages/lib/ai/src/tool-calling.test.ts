import type { CompletionOptions, Message, ToolDefinition } from './types';
import {
    AnthropicMessagesClient,
    buildAnthropicMessagesBody,
    parseAnthropicMessagesResponse,
} from './anthropic-messages';
import { buildChatCompletionsBody, ChatCompletionsClient, parseChatCompletionsResponse } from './chat-completions';
import { buildResponsesBody, parseResponsesResponse, ResponsesClient } from './responses';
import { collectStream } from './testing';
import { WorkersAIClient } from './workers-ai';

const WEATHER_TOOL: ToolDefinition = {
    name: 'get_weather',
    description: 'Get the weather for a city',
    parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
    },
};

const TOOL_CALL = {
    id: 'call_1',
    name: 'get_weather',
    arguments: '{"city":"Helsinki"}',
};

const TOOL_RESULT_MESSAGE: Message = {
    role: 'tool',
    toolCallId: 'call_1',
    content: '{"temperature":5}',
};

const STREAM_TOOLS_ERROR = 'Tool calling is not supported with streaming responses';

describe('chat-completions tool calling', () => {
    it('serializes tool definitions and tool_choice', () => {
        const body = buildChatCompletionsBody(
            {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'weather?' }],
                tools: [WEATHER_TOOL],
                toolChoice: 'required',
            },
            false,
        );
        expect(body.tools).toEqual([
            {
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get the weather for a city',
                    parameters: WEATHER_TOOL.parameters,
                },
            },
        ]);
        expect(body.tool_choice).toBe('required');
    });

    it('maps named tool_choice to function form', () => {
        const body = buildChatCompletionsBody(
            {
                model: 'gpt',
                messages: [],
                tools: [WEATHER_TOOL],
                toolChoice: { type: 'tool', name: 'get_weather' },
            },
            false,
        );
        expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    });

    it('omits tool_choice when no tools are provided', () => {
        const body = buildChatCompletionsBody({ model: 'gpt', messages: [], toolChoice: 'required' }, false);
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });

    it('maps none tool_choice and omits optional tool fields', () => {
        const body = buildChatCompletionsBody(
            { model: 'gpt', messages: [], tools: [{ name: 'ping' }], toolChoice: 'none' },
            false,
        );
        expect(body.tool_choice).toBe('none');
        expect(body.tools).toEqual([{ type: 'function', function: { name: 'ping' } }]);
    });

    it('renders assistant tool calls and tool results', () => {
        const body = buildChatCompletionsBody(
            {
                model: 'gpt',
                messages: [
                    { role: 'user', content: 'weather?' },
                    { role: 'assistant', content: '', toolCalls: [TOOL_CALL] },
                    TOOL_RESULT_MESSAGE,
                ],
            },
            false,
        );
        expect(body.messages).toEqual([
            { role: 'user', content: 'weather?' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"city":"Helsinki"}' },
                    },
                ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: '{"temperature":5}' },
        ]);
    });

    it('parses tool_calls into the common shape', () => {
        const result = parseChatCompletionsResponse({
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{"city":"Helsinki"}' },
                            },
                        ],
                    },
                    finish_reason: 'tool_calls',
                },
            ],
        });
        expect(result.text).toBe('');
        expect(result.toolCalls).toEqual([TOOL_CALL]);
        expect(result.stopReason).toBe('tool_calls');
    });

    it('omits toolCalls when the model answers directly', () => {
        const result = parseChatCompletionsResponse({
            choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        });
        expect(result.text).toBe('hello');
        expect(result.toolCalls).toBeUndefined();
    });

    it('rejects streaming with tools', async () => {
        const client = new ChatCompletionsClient({ fetch: vi.fn() as any });
        const options: CompletionOptions = { model: 'gpt', messages: [], tools: [WEATHER_TOOL] };
        await expect(collectStream(client.stream(options))).rejects.toThrow(STREAM_TOOLS_ERROR);
    });
});

describe('anthropic tool calling', () => {
    it('serializes tool definitions with input_schema', () => {
        const body = buildAnthropicMessagesBody(
            { model: 'claude', messages: [], tools: [WEATHER_TOOL], toolChoice: 'auto' },
            false,
        );
        expect(body.tools).toEqual([
            {
                name: 'get_weather',
                description: 'Get the weather for a city',
                input_schema: WEATHER_TOOL.parameters,
            },
        ]);
        expect(body.tool_choice).toEqual({ type: 'auto' });
    });

    it('maps required and named tool_choice', () => {
        const required = buildAnthropicMessagesBody(
            { model: 'claude', messages: [], tools: [WEATHER_TOOL], toolChoice: 'required' },
            false,
        );
        expect(required.tool_choice).toEqual({ type: 'any' });

        const named = buildAnthropicMessagesBody(
            {
                model: 'claude',
                messages: [],
                tools: [WEATHER_TOOL],
                toolChoice: { type: 'tool', name: 'get_weather' },
            },
            false,
        );
        expect(named.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    });

    it('omits tool_choice when no tools are provided', () => {
        const body = buildAnthropicMessagesBody({ model: 'claude', messages: [], toolChoice: 'required' }, false);
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });

    it('maps none tool_choice and defaults input_schema', () => {
        const body = buildAnthropicMessagesBody(
            { model: 'claude', messages: [], tools: [{ name: 'ping' }], toolChoice: 'none' },
            false,
        );
        expect(body.tool_choice).toEqual({ type: 'none' });
        expect(body.tools).toEqual([{ name: 'ping', input_schema: { type: 'object', properties: {} } }]);
    });

    it('tolerates invalid tool argument JSON', () => {
        const body = buildAnthropicMessagesBody(
            {
                model: 'claude',
                messages: [
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [{ id: 'a', name: 'ping', arguments: 'not json' }],
                    },
                ],
            },
            false,
        );
        expect(body.messages[0].content[0]).toEqual({ type: 'tool_use', id: 'a', name: 'ping', input: {} });
    });

    it('renders assistant tool_use and tool_result blocks', () => {
        const body = buildAnthropicMessagesBody(
            {
                model: 'claude',
                messages: [
                    { role: 'user', content: 'weather?' },
                    { role: 'assistant', content: 'Let me check.', toolCalls: [TOOL_CALL] },
                    TOOL_RESULT_MESSAGE,
                ],
            },
            false,
        );
        expect(body.messages).toEqual([
            { role: 'user', content: 'weather?' },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me check.' },
                    { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Helsinki' } },
                ],
            },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"temperature":5}' }],
            },
        ]);
    });

    it('groups consecutive tool results into one user message', () => {
        const body = buildAnthropicMessagesBody(
            {
                model: 'claude',
                messages: [
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [
                            { id: 'a', name: 'one', arguments: '{}' },
                            { id: 'b', name: 'two', arguments: '{}' },
                        ],
                    },
                    { role: 'tool', toolCallId: 'a', content: 'A' },
                    { role: 'tool', toolCallId: 'b', content: 'B' },
                ],
            },
            false,
        );
        expect(body.messages[1]).toEqual({
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'a', content: 'A' },
                { type: 'tool_result', tool_use_id: 'b', content: 'B' },
            ],
        });
    });

    it('marks tool errors', () => {
        const body = buildAnthropicMessagesBody(
            {
                model: 'claude',
                messages: [{ role: 'tool', toolCallId: 'a', content: 'boom', isError: true }],
            },
            false,
        );
        expect(body.messages[0].content[0]).toEqual({
            type: 'tool_result',
            tool_use_id: 'a',
            content: 'boom',
            is_error: true,
        });
    });

    it('parses tool_use blocks into the common shape', () => {
        const result = parseAnthropicMessagesResponse({
            content: [
                { type: 'text', text: 'Checking' },
                { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Helsinki' } },
            ],
            stop_reason: 'tool_use',
        });
        expect(result.text).toBe('Checking');
        expect(result.toolCalls).toEqual([TOOL_CALL]);
        expect(result.stopReason).toBe('tool_use');
    });

    it('rejects streaming with tools', async () => {
        const client = new AnthropicMessagesClient({ fetch: vi.fn() as any });
        const options: CompletionOptions = { model: 'claude', messages: [], tools: [WEATHER_TOOL] };
        await expect(collectStream(client.stream(options))).rejects.toThrow(STREAM_TOOLS_ERROR);
    });
});

describe('responses tool calling', () => {
    it('serializes function tools and tool_choice', () => {
        const body = buildResponsesBody(
            { model: 'gpt-4o', messages: [], tools: [WEATHER_TOOL], toolChoice: 'auto' },
            false,
        );
        expect(body.tools).toEqual([
            {
                type: 'function',
                name: 'get_weather',
                description: 'Get the weather for a city',
                parameters: WEATHER_TOOL.parameters,
            },
        ]);
        expect(body.tool_choice).toBe('auto');
    });

    it('maps named tool_choice', () => {
        const body = buildResponsesBody(
            {
                model: 'gpt-4o',
                messages: [],
                tools: [WEATHER_TOOL],
                toolChoice: { type: 'tool', name: 'get_weather' },
            },
            false,
        );
        expect(body.tool_choice).toEqual({ type: 'function', name: 'get_weather' });
    });

    it('omits tool_choice when no tools are provided', () => {
        const body = buildResponsesBody({ model: 'gpt-4o', messages: [], toolChoice: 'required' }, false);
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });

    it('maps none tool_choice and omits optional tool fields', () => {
        const body = buildResponsesBody(
            { model: 'gpt-4o', messages: [], tools: [{ name: 'ping' }], toolChoice: 'none' },
            false,
        );
        expect(body.tool_choice).toBe('none');
        expect(body.tools).toEqual([{ type: 'function', name: 'ping' }]);
    });

    it('renders assistant function calls and function outputs', () => {
        const body = buildResponsesBody(
            {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'weather?' },
                    { role: 'assistant', content: 'Checking', toolCalls: [TOOL_CALL] },
                    TOOL_RESULT_MESSAGE,
                ],
            },
            false,
        );
        expect(body.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: 'Checking' }] },
            { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Helsinki"}' },
            { type: 'function_call_output', call_id: 'call_1', output: '{"temperature":5}' },
        ]);
    });

    it('parses function_call items into the common shape', () => {
        const result = parseResponsesResponse({
            output: [
                { type: 'message', content: [{ type: 'output_text', text: 'Checking' }] },
                {
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: 'get_weather',
                    arguments: '{"city":"Helsinki"}',
                },
            ],
            status: 'completed',
        });
        expect(result.text).toBe('Checking');
        expect(result.toolCalls).toEqual([TOOL_CALL]);
        expect(result.stopReason).toBe('stop');
    });

    it('rejects streaming with tools', async () => {
        const client = new ResponsesClient({ fetch: vi.fn() as any });
        const options: CompletionOptions = { model: 'gpt-4o', messages: [], tools: [WEATHER_TOOL] };
        await expect(collectStream(client.stream(options))).rejects.toThrow(STREAM_TOOLS_ERROR);
    });
});

describe('workers tool support', () => {
    it('rejects tools in complete', async () => {
        const client = new WorkersAIClient({ binding: { run: vi.fn() } as any });
        await expect(client.complete({ model: 'llama', messages: [], tools: [WEATHER_TOOL] })).rejects.toThrow(
            'Tool calling is not supported by the workers protocol',
        );
    });

    it('rejects tools in stream before calling REST', async () => {
        const fetchMock = vi.fn();
        const client = new WorkersAIClient({ accountId: 'acc', fetch: fetchMock as any });
        const options: CompletionOptions = { model: 'llama', messages: [], tools: [WEATHER_TOOL] };
        await expect(collectStream(client.stream(options))).rejects.toThrow(
            'Tool calling is not supported by the workers protocol',
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
