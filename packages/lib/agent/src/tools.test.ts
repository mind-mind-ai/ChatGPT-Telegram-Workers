import type { Tool } from './tools';
import { parseToolArguments, ToolRegistry, truncateToolResult } from './tools';

function makeTool(overrides: Partial<Tool> = {}): Tool {
    return {
        name: 'echo',
        description: 'Echo text',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        execute: args => `echo:${String(args.text ?? '')}`,
        ...overrides,
    };
}

describe('ToolRegistry', () => {
    it('registers, resolves and lists tools', () => {
        const registry = new ToolRegistry().register(makeTool());
        expect(registry.size).toBe(1);
        expect(registry.has('echo')).toBe(true);
        expect(registry.get('echo')?.description).toBe('Echo text');
        expect(registry.definitions()).toEqual([
            {
                name: 'echo',
                description: 'Echo text',
                parameters: { type: 'object', properties: { text: { type: 'string' } } },
            },
        ]);
    });

    it('trims names and rejects duplicates or empty names', () => {
        const registry = new ToolRegistry().register(makeTool({ name: '  spaced  ' }));
        expect(registry.has('spaced')).toBe(true);
        expect(() => registry.register(makeTool({ name: 'spaced' }))).toThrow('Tool already registered: spaced');
        expect(() => registry.register(makeTool({ name: '   ' }))).toThrow('Tool name must not be empty');
    });

    it('supports registerAll and clear', () => {
        const registry = new ToolRegistry().registerAll([makeTool({ name: 'a' }), makeTool({ name: 'b' })]);
        expect(registry.size).toBe(2);
        registry.clear();
        expect(registry.size).toBe(0);
    });

    it('filters tools by required permissions and admin status', () => {
        const registry = new ToolRegistry()
            .register(makeTool({ name: 'secret', requiredPermissions: ['tools.secret'] }))
            .register(makeTool({ name: 'public' }));

        expect(registry.definitions().map(tool => tool.name)).toEqual(['public']);
        expect(registry.definitions({ permissions: ['tools.secret'] }).map(tool => tool.name)).toEqual([
            'secret',
            'public',
        ]);
        expect(registry.definitions({ isAdmin: true }).map(tool => tool.name)).toEqual(['secret', 'public']);
        expect(registry.checkAccess('secret', {})).toEqual({
            allowed: false,
            reason: 'missing permission(s): tools.secret',
        });
    });

    it('applies tool-specific canUse policies even for admins', () => {
        const registry = new ToolRegistry().register(
            makeTool({
                name: 'conditional',
                canUse: context => context.userId === 'u1' || 'user not allowed',
            }),
        );

        expect(registry.checkAccess('conditional', { userId: 'u1' })).toEqual({ allowed: true });
        expect(registry.checkAccess('conditional', { userId: 'u2' })).toEqual({
            allowed: false,
            reason: 'user not allowed',
        });
        expect(registry.checkAccess('conditional', { isAdmin: true })).toEqual({
            allowed: false,
            reason: 'user not allowed',
        });
    });

    it('denies access when a policy throws', () => {
        const registry = new ToolRegistry().register(
            makeTool({
                name: 'broken',
                canUse: () => {
                    throw new Error('boom');
                },
            }),
        );
        expect(registry.checkAccess('broken', {})).toEqual({
            allowed: false,
            reason: 'access check failed: boom',
        });
    });

    it('executes a tool with parsed arguments and access context', async () => {
        const execute = vi.fn(async (args: Record<string, unknown>) => `echo:${String(args.text)}`);
        const registry = new ToolRegistry().register(makeTool({ execute }));

        const result = await registry.execute(
            { id: 'c1', name: 'echo', arguments: '{"text":"hi"}' },
            { userId: 'u1', permissions: ['tools.echo'] },
        );

        expect(result).toEqual({ toolCallId: 'c1', content: 'echo:hi' });
        expect(execute).toHaveBeenCalledWith(
            { text: 'hi' },
            expect.objectContaining({
                toolCallId: 'c1',
                access: { userId: 'u1', permissions: ['tools.echo'] },
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it('treats empty arguments as an empty object', async () => {
        const execute = vi.fn((args: Record<string, unknown>) => JSON.stringify(args));
        const registry = new ToolRegistry().register(makeTool({ execute }));

        const result = await registry.execute({ id: 'c1', name: 'echo', arguments: '' });

        expect(result.content).toBe('{}');
        expect(execute).toHaveBeenCalledWith({}, expect.anything());
    });

    it('returns structured errors for unknown tools, denied access and invalid arguments', async () => {
        const execute = vi.fn(() => 'should not run');
        const registry = new ToolRegistry()
            .register(makeTool())
            .register(makeTool({ name: 'secret', requiredPermissions: ['tools.secret'], execute }));

        const unknown = await registry.execute({ id: 'c1', name: 'missing', arguments: '{}' });
        expect(unknown).toMatchObject({ toolCallId: 'c1', isError: true });
        expect(unknown.content).toContain('Unknown tool: missing');

        const denied = await registry.execute({ id: 'c2', name: 'secret', arguments: '{}' });
        expect(denied).toMatchObject({ toolCallId: 'c2', isError: true });
        expect(denied.content).toContain('not permitted');
        expect(execute).not.toHaveBeenCalled();

        const invalid = await registry.execute({ id: 'c3', name: 'echo', arguments: '{bad' });
        expect(invalid).toMatchObject({ toolCallId: 'c3', isError: true });
        expect(invalid.content).toContain('Invalid arguments');
    });

    it('converts thrown tool errors into error results', async () => {
        const registry = new ToolRegistry().register(
            makeTool({
                execute: () => {
                    throw new Error('boom');
                },
            }),
        );

        const result = await registry.execute({ id: 'c1', name: 'echo', arguments: '{}' });

        expect(result).toEqual({
            toolCallId: 'c1',
            content: 'Tool "echo" failed: boom',
            isError: true,
        });
    });

    it('enforces the tool timeout and aborts the tool signal', async () => {
        let observedSignal: AbortSignal | undefined;
        const registry = new ToolRegistry().register(
            makeTool({
                execute: (_args, context) => {
                    observedSignal = context.signal;
                    return new Promise((_resolve, reject) => {
                        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
                    });
                },
            }),
        );

        const result = await registry.execute({ id: 'c1', name: 'echo', arguments: '{}' }, {}, { timeoutMs: 10 });

        expect(result).toMatchObject({ toolCallId: 'c1', isError: true });
        expect(result.content).toContain('timed out after 10 ms');
        expect(observedSignal?.aborted).toBe(true);
    });

    it('propagates parent cancellation as AbortError', async () => {
        const controller = new AbortController();
        const registry = new ToolRegistry().register(
            makeTool({
                execute: (_args, context) =>
                    new Promise((_resolve, reject) => {
                        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
                    }),
            }),
        );

        const promise = registry.execute(
            { id: 'c1', name: 'echo', arguments: '{}' },
            {},
            { signal: controller.signal },
        );
        setTimeout(() => controller.abort(), 5);

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('truncates long results', async () => {
        const registry = new ToolRegistry().register(makeTool({ execute: () => 'x'.repeat(100) }));

        const result = await registry.execute({ id: 'c1', name: 'echo', arguments: '{}' }, {}, { maxResultChars: 40 });

        expect(result.content.length).toBeLessThanOrEqual(40);
        expect(result.content).toContain('truncated');
        expect(truncateToolResult('abcdef', 0)).toBe('abcdef');
    });

    it('parses only JSON objects as arguments', () => {
        expect(parseToolArguments('')).toEqual({ ok: true, value: {} });
        expect(parseToolArguments('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
        expect(parseToolArguments('[]')).toEqual({ ok: false, error: 'arguments must be a JSON object' });
        expect(parseToolArguments('null')).toEqual({ ok: false, error: 'arguments must be a JSON object' });
        expect(parseToolArguments('{bad')).toMatchObject({ ok: false });
    });
});
