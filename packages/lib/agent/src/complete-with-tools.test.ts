import { ENV, normalizeConfig } from '@chatgpt-telegram-workers/config';
import { chatAbortSignal, createChatAgent } from './providers';
import { ToolRegistry } from './tools';
import { createWorkersChat } from './workersai';

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function config(partial: any) {
    return normalizeConfig(partial);
}

afterEach(() => {
    vi.unstubAllGlobals();
    ENV.AI_BINDING = null as any;
});

describe('ChatAgent.completeWithTools', () => {
    it('runs the full tool loop through the chat-completions client', async () => {
        const cfg = config({
            chatProviders: [{ id: 'test', protocol: 'chat-completions', model: 'gpt-4o', apiKey: 'k' }],
        });
        const agent = createChatAgent('chat-completions', cfg.chatProviders[0], cfg.settings);
        const bodies: any[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: string, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body));
                bodies.push(body);
                if (bodies.length === 1) {
                    return jsonResponse({
                        choices: [
                            {
                                message: {
                                    role: 'assistant',
                                    content: '',
                                    tool_calls: [
                                        {
                                            id: 'call_1',
                                            type: 'function',
                                            function: { name: 'echo', arguments: '{"text":"hi"}' },
                                        },
                                    ],
                                },
                                finish_reason: 'tool_calls',
                            },
                        ],
                    });
                }
                return jsonResponse({
                    choices: [{ message: { role: 'assistant', content: 'final' }, finish_reason: 'stop' }],
                });
            }),
        );

        const registry = new ToolRegistry().register({
            name: 'echo',
            description: 'Echo text',
            parameters: { type: 'object', properties: { text: { type: 'string' } } },
            execute: args => `echo:${String(args.text)}`,
        });

        const result = await agent.completeWithTools([{ role: 'user', content: 'hi' }], registry, { maxSteps: 3 });

        expect(result.text).toBe('final');
        expect(result.steps).toBe(2);
        expect(result.toolResults).toEqual([{ toolCallId: 'call_1', content: 'echo:hi' }]);
        expect(bodies[0].tools).toEqual([
            {
                type: 'function',
                function: {
                    name: 'echo',
                    description: 'Echo text',
                    parameters: { type: 'object', properties: { text: { type: 'string' } } },
                },
            },
        ]);
        expect(bodies[1].messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'assistant',
                    tool_calls: [
                        {
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'echo', arguments: '{"text":"hi"}' },
                        },
                    ],
                }),
                expect.objectContaining({
                    role: 'tool',
                    tool_call_id: 'call_1',
                    content: 'echo:hi',
                }),
            ]),
        );
    });

    it('keeps the existing text chat path unchanged', async () => {
        const cfg = config({
            chatProviders: [{ id: 'test', protocol: 'chat-completions', model: 'gpt-4o', apiKey: 'k' }],
        });
        const agent = createChatAgent('chat-completions', cfg.chatProviders[0], cfg.settings);
        const bodies: any[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: string, init?: RequestInit) => {
                bodies.push(JSON.parse(String(init?.body)));
                return jsonResponse({
                    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
                });
            }),
        );

        const text = await agent.chat([{ role: 'user', content: 'hi' }], null);

        expect(text).toBe('hello');
        expect(bodies[0].tools).toBeUndefined();
        expect(bodies[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('rejects tool calling on the workers protocol', async () => {
        ENV.AI_BINDING = { run: vi.fn() } as any;
        const cfg = config({
            chatProviders: [{ id: 'workers', protocol: 'workers', model: '@cf/meta/llama-3-8b-instruct' }],
        });
        const agent = createWorkersChat(cfg.chatProviders[0], cfg.settings);

        expect(agent).not.toBeNull();
        await expect(agent!.completeWithTools([{ role: 'user', content: 'hi' }], new ToolRegistry())).rejects.toThrow(
            'Tool calling is not supported by the workers protocol',
        );
    });

    it('propagates parent cancellation through chatAbortSignal', () => {
        const cfg = config({});
        const parent = new AbortController();
        const { signal, clear } = chatAbortSignal(cfg.settings, parent.signal);

        expect(signal?.aborted).toBe(false);
        parent.abort();
        expect(signal?.aborted).toBe(true);
        clear();
    });
});
