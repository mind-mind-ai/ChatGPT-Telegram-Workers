import type { CompletionResult, ToolCall } from '@chatgpt-telegram-workers/ai';
import { MockSandboxClient, createSandboxWorkspace, type MockExecHandler } from '@chatgpt-telegram-workers/sandbox';
import { describe, expect, it } from 'vitest';
import type { AgentLLMRequest } from '../runtime';
import { AgentRuntime } from '../runtime';
import { ToolRegistry } from '../tools';
import { CODING_TOOL_PERMISSION } from './constants';
import { registerCodingTools } from './tools';

const SCOPE = { userId: 'alice', repository: 'owner/repo', sessionId: 's1' };
const ACCESS = {
    userId: SCOPE.userId,
    repository: SCOPE.repository,
    sessionId: SCOPE.sessionId,
    permissions: [CODING_TOOL_PERMISSION],
};

const TOOL_NAMES = [
    'shell_exec',
    'fs_list',
    'fs_read',
    'fs_write',
    'fs_edit',
    'fs_rename',
    'fs_delete',
    'git_status',
    'git_diff',
];

async function createFixture(execHandler?: MockExecHandler) {
    const workspace = await createSandboxWorkspace(SCOPE);
    const client = new MockSandboxClient({
        workspace,
        files: {
            'README.md': 'hello world\n',
            'src/a.ts': 'const a = 1;\n',
        },
        execHandler,
    });
    const registry = new ToolRegistry();
    registerCodingTools(registry, { sandbox: client });
    const call = (name: string, args: Record<string, unknown>): ToolCall => ({
        id: `${name}-1`,
        name,
        arguments: JSON.stringify(args),
    });
    return { workspace, client, registry, call };
}

describe('registerCodingTools', () => {
    it('registers all coding tools behind the coding permission', async () => {
        const { registry } = await createFixture();
        expect(registry.size).toBe(TOOL_NAMES.length);
        expect(registry.definitions()).toEqual([]);
        expect(registry.definitions({ permissions: ['web'] })).toEqual([]);
        expect(registry.definitions({ permissions: [CODING_TOOL_PERMISSION] }).map(tool => tool.name)).toEqual(
            TOOL_NAMES,
        );
        expect(
            registry.definitions({
                permissions: [CODING_TOOL_PERMISSION],
                userId: 'bob',
                repository: 'other/repo',
                sessionId: 's1',
            }),
        ).toEqual([]);
    });

    it('accepts a SandboxClient directly', async () => {
        const workspace = await createSandboxWorkspace(SCOPE);
        const client = new MockSandboxClient({ workspace });
        const registry = registerCodingTools(new ToolRegistry(), client);
        expect(registry.definitions({ permissions: [CODING_TOOL_PERMISSION] })).toHaveLength(TOOL_NAMES.length);
    });
});

describe('coding tools', () => {
    it('runs shell commands in the sandbox and enforces output limits', async () => {
        const { registry, client, call } = await createFixture(({ command, cwd }) => ({
            stdout: `${command} in ${cwd}: 0123456789`,
            stderr: 'warning',
            exitCode: 0,
        }));

        const result = await registry.execute(
            call('shell_exec', { command: 'echo hi', cwd: 'src', max_output_bytes: 8 }),
            ACCESS,
        );
        expect(result.isError).toBeFalsy();
        expect(result.content).toContain('Command: echo hi');
        expect(result.content).toContain('Cwd: src');
        expect(result.content).toContain('Truncated: yes');
        expect(client.commands).toEqual(['echo hi']);
    });

    it('reads, writes, edits, lists, renames and deletes workspace files', async () => {
        const { registry, client, call } = await createFixture();

        expect((await registry.execute(call('fs_list', {}), ACCESS)).content).toContain('README.md');
        const read = await registry.execute(call('fs_read', { path: 'README.md' }), ACCESS);
        expect(read.content).toContain('hello world');

        const write = await registry.execute(
            call('fs_write', { path: 'src/new.ts', content: 'export const value = 1;\n' }),
            ACCESS,
        );
        expect(write.isError).toBeFalsy();
        expect(new TextDecoder().decode(await client.readFile('src/new.ts'))).toBe('export const value = 1;\n');

        const edit = await registry.execute(
            call('fs_edit', { path: 'src/new.ts', old_text: '1', new_text: '2' }),
            ACCESS,
        );
        expect(edit.isError).toBeFalsy();
        expect(new TextDecoder().decode(await client.readFile('src/new.ts'))).toBe('export const value = 2;\n');

        await registry.execute(call('fs_rename', { from: 'src/new.ts', to: 'src/renamed.ts' }), ACCESS);
        expect(new TextDecoder().decode(await client.readFile('src/renamed.ts'))).toContain('value = 2');
        await registry.execute(call('fs_delete', { path: 'src/renamed.ts' }), ACCESS);
        expect(await client.list('src')).toMatchObject({ entries: [{ name: 'a.ts', type: 'file' }] });
    });

    it('runs git status and git diff inside the sandbox', async () => {
        const { registry, client, call } = await createFixture(({ command }) => ({
            stdout: command,
            stderr: '',
            exitCode: 0,
        }));

        const status = await registry.execute(call('git_status', {}), ACCESS);
        expect(status.content).toContain('git status --short --branch');

        const diff = await registry.execute(call('git_diff', { path: 'src/a.ts', staged: true }), ACCESS);
        expect(diff.content).toContain(`git diff --cached -- 'src/a.ts'`);
        expect(client.commands).toEqual(['git status --short --branch', `git diff --cached -- 'src/a.ts'`]);
    });

    it('denies callers who do not own the user, repository and session', async () => {
        const { registry, client, call } = await createFixture();
        for (const access of [
            { ...ACCESS, userId: 'bob' },
            { ...ACCESS, repository: 'other/repo' },
            { ...ACCESS, sessionId: 'other' },
            { ...ACCESS, permissions: [] },
        ]) {
            const result = await registry.execute(call('fs_read', { path: 'README.md' }), access);
            expect(result.isError).toBe(true);
            expect(result.content).toMatch(/not permitted|Coding tool denied/);
        }
        expect(client.commands).toEqual([]);
    });

    it('rejects absolute paths and workspace traversal', async () => {
        const { registry, call } = await createFixture();
        for (const path of ['/etc/passwd', '../secret', 'src/../../secret']) {
            const result = await registry.execute(call('fs_read', { path }), ACCESS);
            expect(result.isError).toBe(true);
            expect(result.content).toContain('invalid-path');
        }

        const shell = await registry.execute(call('shell_exec', { command: 'pwd', cwd: '../' }), ACCESS);
        expect(shell.isError).toBe(true);
        expect(shell.content).toContain('invalid-path');
    });

    it('returns a sandbox timeout as a tool error', async () => {
        const { registry, call } = await createFixture(() => new Promise<never>(() => {}));
        const result = await registry.execute(call('shell_exec', { command: 'sleep 10', timeout_ms: 5 }), ACCESS);
        expect(result.isError).toBe(true);
        expect(result.content).toContain('timeout');
    });

    it('propagates cancellation instead of returning a successful result', async () => {
        const { registry, call } = await createFixture(
            ({ signal }) =>
                new Promise<never>((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
                }),
        );
        const controller = new AbortController();
        const pending = registry.execute(call('shell_exec', { command: 'sleep 10' }), ACCESS, {
            signal: controller.signal,
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('AgentRuntime coding integration', () => {
    it('exposes coding tools to the model and executes them through the sandbox', async () => {
        const { registry } = await createFixture();
        const requests: AgentLLMRequest[] = [];
        const responses: CompletionResult[] = [
            { text: '', toolCalls: [{ id: 'r1', name: 'fs_read', arguments: '{"path":"README.md"}' }] },
            { text: 'The readme says hello world.' },
        ];
        const runtime = new AgentRuntime(async request => {
            requests.push(request);
            return responses.shift()!;
        });

        const result = await runtime.run([{ role: 'user', content: 'Read the README.' }], registry, {
            access: ACCESS,
            maxSteps: 4,
        });

        expect(requests[0].tools.map(tool => tool.name)).toEqual(TOOL_NAMES);
        expect(result.toolResults[0].content).toContain('hello world');
        expect(result.text).toBe('The readme says hello world.');
    });
});
