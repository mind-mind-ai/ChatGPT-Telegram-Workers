import type * as Telegram from 'telegram-bot-api-types';
import type { MessageHandler, UpdateHandler } from './types';

function logInvalidMessage(reason: string): void {
    // Deliberately excludes message text, sender data, callback data, and tokens.
    console.warn('[telegram] ignored invalid update', { reason });
}

/**
 * 通用中间件:从 Update 中取出 Message,依次交给消息中间件处理
 */
export class Update2MessageHandler<Context = unknown> implements UpdateHandler<Context> {
    messageHandlers: MessageHandler<Context>[];

    constructor(messageHandlers: MessageHandler<Context>[]) {
        this.messageHandlers = messageHandlers;
    }

    loadMessage(body: Telegram.Update): Telegram.Message | null {
        if (body.edited_message) {
            return null;
        }
        if (!body.message || typeof body.message !== 'object') {
            return null;
        }
        const message = body.message as unknown as Record<string, unknown>;
        const chat = message.chat;
        if (!chat || typeof chat !== 'object') {
            logInvalidMessage('invalid-chat');
            return null;
        }
        const chatRecord = chat as Record<string, unknown>;
        if (typeof chatRecord.id !== 'number' || chatRecord.id === 0 || typeof chatRecord.type !== 'string') {
            logInvalidMessage('invalid-chat');
            return null;
        }
        if (message.text != null && typeof message.text !== 'string') {
            logInvalidMessage('invalid-text');
            return null;
        }
        if (message.caption != null && typeof message.caption !== 'string') {
            logInvalidMessage('invalid-caption');
            return null;
        }
        return body.message;
    }

    handle = async (update: Telegram.Update, context: Context): Promise<Response | null> => {
        const message = this.loadMessage(update);
        if (!message) {
            return null;
        }
        for (const handler of this.messageHandlers) {
            const result = await handler.handle(message, context);
            if (result) {
                return result;
            }
        }
        return null;
    };
}
