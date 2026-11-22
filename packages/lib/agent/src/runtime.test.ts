import type { CompletionResult } from '@chatgpt-telegram-workers/ai';
import type { AgentLLMComplete, AgentLLMRequest } from './runtime';
import { AgentRuntime } from './runtime';
import { ToolRegistry } from './tools';
import { AgentTimeoutError } from './errors';

function scriptedLLM(responses: CompletionResult[]) {
    const requests: AgentLLMRequest[] = [];
    const complete: AgentLLMComplete = async request => {
        requests.push(request);
        const response = responses.shift();
        if (!response) {
            throw new Error('No scripted response left');
        }
        return response;
    };
    return { complete, requests };
}

const USER_MESSAGE = { role: 'user' as const, content: 'go' };

describe('AgentRuntime', () => {
    it('returns a direct answer without tool calls', async () => {
        const { complete, requests } = scriptedLLM([{ text: 'hello' }]);
        const result = await new AgentRuntime(complete).run([USER_MESSAGE], new ToolRegistry());

        expect(result.text).toBe('hello');
        expect(result.steps).toBe(1);
        expect(result.stopReason).toBe('complete');
        expect(result.toolCalls).toEqual([]);
        expect(result.toolResults).toEqual([]);
        expect(result.messages).toEqual([USER_MESSAGE, { role: 'assistant', content: 'hello' }]);
        expect(requests[0].tools).toEqual([]);
        expect(requests[0].toolChoice).toBe('auto');
    });

    it('forwards an optional coding system prompt without changing normal chat', async () => {
        const normal = scriptedLLM([{ text: 'hello' }]);
        await new AgentRuntime(normal.complete).run([USER_MESSAGE], new ToolRegistry());
        expect(normal.requests[0].system).toBeUndefined();

        const coding = scriptedLLM([{ text: 'done' }]);
        await new AgentRuntime(coding.complete).run([USER_MESSAGE], new ToolRegistry(), {
            system: 'coding-only prompt',
        });
        expect(coding.requests[0].system).toBe('coding-only prompt');
    });

    it('executes a tool call and feeds the result back to the model', async () => {
        const registry = new ToolRegistry().register({
            name: 'echo',
            description: 'Echo text',
            parameters: { type: 'object', properties: { text: { type: 'string' } } },
            execute: args => `echo:${String(args.text)}`,
        });
        const call = { id: 'c1', name: 'echo', arguments: '{"text":"hi"}' };
        const { complete, requests } = scriptedLLM([{ text: '', toolCalls: [call] }, { text: 'done' }]);

        const result = await new AgentRuntime(complete).run([USER_MESSAGE], registry);

        expect(result.text).toBe('done');
        expect(result.steps).toBe(2);
        expect(result.stopReason).toBe('complete');
        expect(result.toolCalls).toEqual([call]);
        expect(result.toolResults).toEqual([{ toolCallId: 'c1', content: 'echo:hi' }]);
        expect(result.messages).toEqual([
            USER_MESSAGE,
            { role: 'assistant', content: '', toolCalls: [call] },
            { role: 'tool', toolCallId: 'c1', name: 'echo', content: 'echo:hi' },
            { role: 'assistant', content: 'done' },
        ]);
        expect(requests[0].tools).toEqual([
            {
                name: 'echo',
                description: 'Echo text',
                parameters: { type: 'object', properties: { text: { type: 'string' } } },
            },
        ]);
        expect(requests[1].messages).toEqual(result.messages.slice(0, 3));
    });

    it('executes multiple tool calls in order', async () => {
        const registry = new ToolRegistry()
            .register({
                name: 'first',
                description: 'First',
                execute: () => 'one',
            })
            .register({
                name: 'second',
                description: 'Second',
                execute: () => 'two',
            });
        const { complete } = scriptedLLM([
            {
                text: '',
                toolCalls: [
                    { id: 'a', name: 'first', arguments: '{}' },
                    { id: 'b', name: 'second', arguments: '{}' },
                ],
            },
            { text: 'done' },
        ]);

        const result = await new AgentRuntime(complete).run([USER_MESSAGE], registry);

        expect(result.toolResults).toEqual([
            { toolCallId: 'a', content: 'one' },
            { toolCallId: 'b', content: 'two' },
        ]);
    });

    it('feeds tool errors back to the model', async () => {
        const registry = new ToolRegistry().register({
            name: 'fail',
            description: 'Fail',
            execute: () => {
                throw new Error('boom');
            },
        });
        const { complete, requests } = scriptedLLM([
            { text: '', toolCalls: [{ id: 'c1', name: 'fail', arguments: '{}' }] },
            { text: 'recovered' },
        ]);

        const result = await new AgentRuntime(complete).run([USER_MESSAGE], registry);

        expect(result.text).toBe('recovered');
        expect(result.toolResults).toEqual([{ toolCallId: 'c1', content: 'Tool "fail" failed: boom', isError: true }]);
        expect(requests[1].messages[2]).toEqual({
            role: 'tool',
            toolCallId: 'c1',
            name: 'fail',
            content: 'Tool "fail" failed: boom',
            isError: true,
        });
    });

    it('feeds unknown tools, invalid arguments and denied access back as errors', async () => {
        const registry = new ToolRegistry()
            .register({ name: 'echo', description: 'Echo', execute: args => String(args.text) })
            .register({
                name: 'secret',
                description: 'Secret',
                requiredPermissions: ['tools.secret'],
                execute: () => 'secret',
            });
        const { complete } = scriptedLLM([
            {
                text: '',
                toolCalls: [
                    { id: 'a', name: 'missing', arguments: '{}' },
                    { id: 'b', name: 'echo', arguments: '{bad' },
                    { id: 'c', name: 'secret', arguments: '{}' },
                ],
            },
            { text: 'done' },
        ]);

        const result = await new AgentRuntime(complete).run([USER_MESSAGE], registry);

        expect(result.toolResults).toHaveLength(3);
        expect(result.toolResults[0].content).toContain('Unknown tool: missing');
        expect(result.toolResults[1].content).toContain('Invalid arguments');
        expect(result.toolResults[2].content).toContain('not permitted');
        expect(result.toolResults.every(toolResult => toolResult.isError)).toBe(true);
    });

    it('stops at maxSteps without executing tools on the last allowed step', async () => {
        const execute = vi.fn(() => 'ok');
        const registry = new ToolRegistry().register({ name: 'echo', description: 'Echo', execute });
        const { complete } = scriptedLLM([
            { text: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }] },
            { text: '', toolCalls: [{ id: 'c2', name: 'echo', arguments: '{}' }] },
        ]);

        const result = await new AgentRuntime(complete).run([USER_MESSAGE], registry, { maxSteps: 2 });

        expect(result.stopReason).toBe('max-steps');
        expect(result.steps).toBe(2);
        expect(result.toolCalls).toHaveLength(2);
        expect(result.toolResults).toHaveLength(2);
        expect(result.toolResults[1]).toMatchObject({ toolCallId: 'c2', isError: true });
        expect(result.toolResults[1].content).toContain('maximum steps');
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid maxSteps values', async () => {
        const { complete } = scriptedLLM([{ text: 'unused' }]);
        const runtime = new AgentRuntime(complete);

        await expect(runtime.run([USER_MESSAGE], new ToolRegistry(), { maxSteps: 0 })).rejects.toThrow(RangeError);
        await expect(runtime.run([USER_MESSAGE], new ToolRegistry(), { maxSteps: 1.5 })).rejects.toThrow(RangeError);
    });

    it('converts tool timeouts into error results and continues', async () => {
        const registry = new ToolRegistry().register({
            name: 'slow',
            description: 'Slow',
            execute: (_args, context) =>
                new Promise((_resolve, reject) => {
                    context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
                }),
        });
        const { complete } = scriptedLLM([
            { text: '', toolCalls: [{ id: 'c1', name: 'slow', arguments: '{}' }] },
            { text: 'done' },
        ]);

        const result = await new AgentRuntime(complete).run([USER_MESSAGE], registry, { toolTimeoutMs: 10 });

        expect(result.text).toBe('done');
        expect(result.toolResults[0]).toMatchObject({ toolCallId: 'c1', isError: true });
        expect(result.toolResults[0].content).toContain('timed out');
    });

    it('aborts the whole run on timeout', async () => {
        const complete: AgentLLMComplete = () => new Promise(() => {});
        const runtime = new AgentRuntime(complete);

        await expect(runtime.run([USER_MESSAGE], new ToolRegistry(), { timeoutMs: 10 })).rejects.toBeInstanceOf(
            AgentTimeoutError,
        );
    });

    it('honours cancellation before and during the run', async () => {
        const { complete } = scriptedLLM([{ text: 'hello' }]);
        const runtime = new AgentRuntime(complete);

        const before = new AbortController();
        before.abort();
        await expect(runtime.run([USER_MESSAGE], new ToolRegistry(), { signal: before.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });

        const during = new AbortController();
        const registry = new ToolRegistry().register({
            name: 'wait',
            description: 'Wait',
            execute: (_args, context) =>
                new Promise((_resolve, reject) => {
                    context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
                }),
        });
        const scripted = scriptedLLM([
            { text: '', toolCalls: [{ id: 'c1', name: 'wait', arguments: '{}' }] },
            { text: 'never' },
        ]);
        const promise = new AgentRuntime(scripted.complete).run([USER_MESSAGE], registry, {
            signal: during.signal,
        });
        setTimeout(() => during.abort(), 5);

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('aggregates usage and truncates results per result and in total', async () => {
        const registry = new ToolRegistry()
            .register({ name: 'first', description: 'First', execute: () => 'a'.repeat(20) })
            .register({ name: 'second', description: 'Second', execute: () => 'b'.repeat(20) });
        const { complete } = scriptedLLM([
            {
                text: '',
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                toolCalls: [
                    { id: 'a', name: 'first', arguments: '{}' },
                    { id: 'b', name: 'second', arguments: '{}' },
                ],
            },
            {
                text: 'done',
                usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
            },
        ]);

        const result = await new AgentRuntime(complete).run([USER_MESSAGE], registry, {
            maxToolResultChars: 100,
            maxTotalToolResultChars: 25,
        });

        expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
        expect(result.toolResults[0].content).toHaveLength(20);
        expect(result.toolResults[1].content).toHaveLength(5);
    });

    it('omits results after the total result budget is exhausted', async () => {
        const registry = new ToolRegistry()
            .register({ name: 'first', description: 'First', execute: () => 'a'.repeat(30) })
            .register({ name: 'second', description: 'Second', execute: () => 'b'.repeat(10) });
        const { complete } = scriptedLLM([
            {
                text: '',
                toolCalls: [
                    { id: 'a', name: 'first', arguments: '{}' },
                    { id: 'b', name: 'second', arguments: '{}' },
                ],
            },
            { text: 'done' },
        ]);

        const result = await new AgentRuntime(complete).run([USER_MESSAGE], registry, {
            maxToolResultChars: 100,
            maxTotalToolResultChars: 20,
        });

        expect(result.toolResults[0].content).toHaveLength(20);
        expect(result.toolResults[1].content).toContain('omitted');
    });

    it('passes only accessible tools and the requested toolChoice to the model', async () => {
        const registry = new ToolRegistry()
            .register({
                name: 'secret',
                description: 'Secret',
                requiredPermissions: ['tools.secret'],
                execute: () => '',
            })
            .register({ name: 'public', description: 'Public', execute: () => '' });
        const { complete, requests } = scriptedLLM([{ text: 'done' }]);

        await new AgentRuntime(complete).run([USER_MESSAGE], registry, {
            access: { permissions: [] },
            toolChoice: 'required',
        });

        expect(requests[0].tools.map(tool => tool.name)).toEqual(['public']);
        expect(requests[0].toolChoice).toBe('required');
    });
});
