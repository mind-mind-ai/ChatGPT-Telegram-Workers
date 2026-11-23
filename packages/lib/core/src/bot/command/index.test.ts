import { cloneDefaultConfig, ENV } from '@chatgpt-telegram-workers/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { context, message } from '../coding/test-helpers';
import { handleCommandMessage, isCodingCommandText } from './index';

describe('custom command coding boundary', () => {
    beforeEach(() => {
        ENV.CONFIG = cloneDefaultConfig();
    });

    afterEach(() => {
        ENV.CONFIG = cloneDefaultConfig();
    });

    it('identifies only coding system commands', () => {
        for (const value of ['/code', '/code_status', '/code_stop', '/code@bot', ' /code ']) {
            expect(isCodingCommandText(value)).toBe(true);
        }
        for (const value of ['/codefoo', '/start', 'hello /code', '', 123]) {
            expect(isCodingCommandText(value)).toBe(false);
        }
    });

    it('does not expand a custom command into a coding command', async () => {
        for (const value of ['/code', '/code_status', '/code_stop', '/code@bot']) {
            ENV.CONFIG.customCommands = [
                {
                    id: 'custom-1',
                    command: '/startcode',
                    description: 'attempted escalation',
                    scope: ['all_private_chats'],
                    value,
                    enabled: true,
                },
            ];
            await expect(handleCommandMessage(message({ text: '/startcode' }), context())).resolves.toBeNull();
        }
    });

    it('leaves unrelated text alone', async () => {
        ENV.CONFIG.customCommands = [
            {
                id: 'custom-2',
                command: '/hello',
                description: 'normal custom command',
                scope: ['all_private_chats'],
                value: 'hello',
                enabled: true,
            },
        ];
        await expect(handleCommandMessage(message({ text: 'plain text' }), context())).resolves.toBeNull();
    });
});
