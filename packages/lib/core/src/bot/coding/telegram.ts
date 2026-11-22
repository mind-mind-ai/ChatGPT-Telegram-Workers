import type * as Telegram from 'telegram-bot-api-types';
import { createTelegramBotAPI, MessageSender } from '@chatgpt-telegram-workers/telegram';

export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Split plain text without exceeding Telegram's per-message limit. */
export function splitTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
    if (!text) {
        return [''];
    }
    const safeLimit = Math.max(1, Math.trunc(limit));
    const parts: string[] = [];
    let rest = text;
    while (rest.length > safeLimit) {
        let cut = rest.lastIndexOf('\n', safeLimit);
        if (cut <= 0) {
            cut = rest.lastIndexOf(' ', safeLimit);
        }
        if (cut <= 0) {
            cut = safeLimit;
        }
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    parts.push(rest);
    return parts;
}

/** Send a long result through any CodingReply implementation, one safe part at a time. */
export async function sendLongText(reply: CodingReply, text: string): Promise<Response> {
    let last: Response = new Response('OK', { status: 200 });
    for (const part of splitTelegramMessage(text)) {
        last = await reply.sendText(part);
    }
    return last;
}

export interface CodingReply {
    sendText(text: string): Promise<Response>;
    sendKeyboard(text: string, keyboard: Telegram.InlineKeyboardMarkup): Promise<Response>;
    sendDocument(filename: string, content: Uint8Array, caption?: string): Promise<Response>;
    answerCallback(text?: string): Promise<void>;
}

export type CodingReplyFactory = (token: string, update: Telegram.Update) => CodingReply;

async function sendParts(sender: MessageSender, text: string): Promise<Response> {
    let last: Response | null = null;
    for (const part of splitTelegramMessage(text)) {
        last = await sender.sendPlainText(part);
        if (!last.ok) {
            break;
        }
    }
    return last ?? new Response('OK', { status: 200 });
}

export function createMessageReply(token: string, message: Telegram.Message): CodingReply {
    const sender = MessageSender.fromMessage(token, message);
    return {
        sendText: text => sendParts(sender, text),
        sendKeyboard: (text, keyboard) =>
            sender.sendRawMessage({
                chat_id: message.chat.id,
                text,
                reply_markup: keyboard,
            }),
        sendDocument: (filename, content, caption) =>
            createTelegramBotAPI(token).sendDocument({
                chat_id: message.chat.id,
                document: new Blob([content as unknown as ArrayBuffer], { type: 'text/plain' }),
                filename,
                ...(caption ? { caption: caption.slice(0, 1024) } : {}),
            } as Telegram.SendDocumentParams),
        answerCallback: async () => undefined,
    };
}

export function createCallbackReply(token: string, callback: Telegram.CallbackQuery): CodingReply {
    const sender = MessageSender.fromCallbackQuery(token, callback);
    const api = createTelegramBotAPI(token);
    return {
        sendText: text => sendParts(sender, text),
        sendKeyboard: (text, keyboard) =>
            sender.sendRawMessage({
                chat_id: sender.context.chat_id,
                text,
                reply_markup: keyboard,
            }),
        sendDocument: (filename, content, caption) =>
            api.sendDocument({
                chat_id: sender.context.chat_id,
                document: new Blob([content as unknown as ArrayBuffer], { type: 'text/plain' }),
                filename,
                ...(caption ? { caption: caption.slice(0, 1024) } : {}),
            } as Telegram.SendDocumentParams),
        answerCallback: async text => {
            await api
                .answerCallbackQuery({
                    callback_query_id: callback.id,
                    ...(text ? { text } : {}),
                })
                .then(response => response.json())
                .catch(() => undefined);
        },
    };
}

export function createReplyForUpdate(token: string, update: Telegram.Update): CodingReply {
    if (update.callback_query) {
        return createCallbackReply(token, update.callback_query);
    }
    if (update.message) {
        return createMessageReply(token, update.message);
    }
    throw new Error('Invalid update');
}
