import type * as Telegram from 'telegram-bot-api-types';
import { Update2MessageHandler } from '@chatgpt-telegram-workers/telegram';
import { cloneDefaultConfig, ENV } from '@chatgpt-telegram-workers/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { context, fakeCoordinator, coordinatorFactory, message } from '../coding/test-helpers';
import { CodingCallbackHandler, CodingMessageHandler } from './coding';
import { AccessFilter, CommandHandler, ServiceMessageFilter } from './handlers';

describe('malformed Telegram update handling', () => {
    beforeEach(() => {
        ENV.CONFIG = cloneDefaultConfig();
    });

    afterEach(() => {
        ENV.CONFIG = cloneDefaultConfig();
    });

    it('ignores edited and structurally invalid messages in Update2MessageHandler', async () => {
        const seen: Telegram.Message[] = [];
        const handler = new Update2MessageHandler([
            {
                handle: async (value: Telegram.Message) => {
                    seen.push(value);
                    return null;
                },
            },
        ]);

        await expect(
            handler.handle({ update_id: 1, edited_message: message() } as Telegram.Update, {}),
        ).resolves.toBeNull();
        await expect(handler.handle({ update_id: 2 } as Telegram.Update, {})).resolves.toBeNull();
        await expect(
            handler.handle({ update_id: 3, message: message({ chat: undefined as never }) } as Telegram.Update, {}),
        ).resolves.toBeNull();
        await expect(
            handler.handle({ update_id: 4, message: message({ text: 123 as never }) } as Telegram.Update, {}),
        ).resolves.toBeNull();
        expect(seen).toHaveLength(0);
    });

    it('ignores malformed updates in AccessFilter', async () => {
        const filter = new AccessFilter();
        await expect(filter.handle({ update_id: 1 } as Telegram.Update, context())).resolves.toBeNull();
        await expect(
            filter.handle(
                {
                    update_id: 2,
                    callback_query: { id: 'cb', chat_instance: 'instance', data: 'm:0', message: message() },
                } as Telegram.Update,
                context(),
            ),
        ).resolves.toBeNull();
    });

    it('ignores non-string command text', async () => {
        await expect(new CommandHandler().handle(message({ text: 123 as never }), context())).resolves.toBeNull();
    });

    it('ignores non-string callback data without throwing', async () => {
        const handler = new CodingCallbackHandler({
            coordinator: coordinatorFactory(fakeCoordinator()),
            reply: () => ({ sendText: async () => new Response('OK') }) as never,
        });
        await expect(
            handler.handle(
                {
                    update_id: 1,
                    callback_query: {
                        id: 'cb',
                        chat_instance: 'instance',
                        from: { id: 10, is_bot: false, first_name: 'User' },
                        data: 123 as never,
                        message: message(),
                    },
                } as Telegram.Update,
                context(),
            ),
        ).resolves.toBeNull();
    });

    it('handles callbacks with missing message or sender safely', async () => {
        const handler = new CodingCallbackHandler();
        const response = await handler.handle(
            {
                update_id: 1,
                callback_query: { id: 'cb', chat_instance: 'instance', data: 'code:repo:0' },
            } as Telegram.Update,
            context(),
        );
        expect(response?.status).toBe(200);
    });

    it('ignores coding messages with missing chat', async () => {
        const handler = new CodingMessageHandler({
            coordinator: coordinatorFactory(fakeCoordinator()),
            reply: () => ({ sendText: async () => new Response('OK') }) as never,
        });
        await expect(handler.handle(message({ chat: undefined as never }), context())).resolves.toBeNull();
    });

    it('returns 200 for service messages instead of throwing', async () => {
        const response = await new ServiceMessageFilter().handle(
            { update_id: 1, message: message({ new_chat_members: [] }) } as Telegram.Update,
            context(),
        );
        expect(response?.status).toBe(200);
    });
});
