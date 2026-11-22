import type { Message } from '@chatgpt-telegram-workers/ai';
import { cloneDefaultConfig, ENV } from '@chatgpt-telegram-workers/config';
import { requestAgentCompletionsFromLLM } from './chat';
import { ToolRegistry } from './tools';
import type { ChatAgent } from './types';

function fakeDatabase(): {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string) => Promise<void>;
} & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        get: async (key: string) => data.get(key) ?? null,
        put: async (key: string, value: string) => {
            data.set(key, value);
        },
    };
}

function fakeAgent(captured: Message[][]): ChatAgent {
    return {
        name: 'fake',
        label: 'Fake',
        model: 'fake-model',
        modelList: async () => ['fake-model'],
        chat: async () => 'chat',
        completeWithTools: async messages => {
            captured.push(messages);
            return {
                text: 'final answer',
                messages,
                steps: 1,
                toolCalls: [],
                toolResults: [],
                stopReason: 'complete',
            };
        },
    };
}

beforeEach(() => {
    ENV.CONFIG = cloneDefaultConfig();
    ENV.CONFIG.settings.autoTrimHistory = true;
    ENV.CONFIG.settings.maxHistoryLength = 20;
    ENV.CONFIG.settings.historyImagePlaceholder = '[image omitted]';
});

describe('requestAgentCompletionsFromLLM', () => {
    it('stores the image placeholder, not image bytes or tool results', async () => {
        const database = fakeDatabase();
        ENV.DATABASE = database as any;
        const captured: Message[][] = [];
        const imageMessage: Message = {
            role: 'user',
            content: [
                { type: 'text', text: 'What is this?' },
                { type: 'image', image: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
            ],
        };

        const result = await requestAgentCompletionsFromLLM(
            imageMessage,
            'history-key',
            ENV.CONFIG,
            fakeAgent(captured),
            new ToolRegistry(),
        );

        expect(result.text).toBe('final answer');
        expect(captured[0][0]).toEqual(imageMessage);
        const stored = JSON.parse(database.data.get('history-key') ?? '[]') as Message[];
        expect(stored).toHaveLength(2);
        expect(stored[0].content).toEqual([{ type: 'text', text: 'What is this? [image omitted]' }]);
        expect(JSON.stringify(stored)).not.toContain('"image"');
        expect(stored[1]).toEqual({ role: 'assistant', content: 'final answer' });
    });

    it('does not persist when history is disabled', async () => {
        const database = fakeDatabase();
        ENV.DATABASE = database as any;
        ENV.CONFIG.settings.maxHistoryLength = 0;

        await requestAgentCompletionsFromLLM(
            { role: 'user', content: 'hello' },
            'history-key',
            ENV.CONFIG,
            fakeAgent([]),
            new ToolRegistry(),
        );

        expect(database.data.has('history-key')).toBe(false);
    });
});
