import type * as Telegram from 'telegram-bot-api-types';
import type { MessageHandler, UpdateHandler } from './types';

/**
 * 通用中间件:从 Update 中取出 Message,依次交给消息中间件处理
 */
export class Update2MessageHandler<Context = unknown> implements UpdateHandler<Context> {
    messageHandlers: MessageHandler<Context>[];

    constructor(messageHandlers: MessageHandler<Context>[]) {
        this.messageHandlers = messageHandlers;
    }

    loadMessage(body: Telegram.Update): Telegram.Message | null {
        if (body.edited_message || !body.message || typeof body.message !== 'object') {
            return null;
        }
        const message = body.message as unknown as Record<string, unknown>;
        const chat = message.chat;
        if (!chat || typeof chat !== 'object') {
            return null;
        }
        const chatRecord = chat as Record<string, unknown>;
        if (typeof chatRecord.id !== 'number' || chatRecord.id === 0 || typeof chatRecord.type !== 'string') {
            return null;
        }
        if (message.text !== undefined && typeof message.text !== 'string') {
            return null;
        }
        if (message.caption !== undefined && typeof message.caption !== 'string') {
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
