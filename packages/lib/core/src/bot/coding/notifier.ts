import type * as Telegram from 'telegram-bot-api-types';
import type { TelegramBotAPI } from '@chatgpt-telegram-workers/telegram';
import { createTelegramBotAPI } from '@chatgpt-telegram-workers/telegram';
import { splitTelegramMessage } from './telegram';
import type { CodingTelegramTarget } from './types';

export interface CodingTelegramMessageOptions {
    keyboard?: Telegram.InlineKeyboardMarkup;
}

export interface CodingTelegramDocumentOptions extends CodingTelegramMessageOptions {
    caption?: string;
}

export interface CodingJobNotifier {
    notify(
        target: CodingTelegramTarget | undefined,
        text: string,
        options?: CodingTelegramMessageOptions,
    ): Promise<number | undefined>;
    sendDocument?(
        target: CodingTelegramTarget | undefined,
        filename: string,
        content: Uint8Array,
        options?: CodingTelegramDocumentOptions,
    ): Promise<number | undefined>;
}

interface TelegramResult {
    ok?: boolean;
    result?: { message_id?: number };
    description?: string;
}

/**
 * Best-effort Telegram progress channel. API failures are swallowed so a
 * Telegram outage can never change the authoritative job state.
 */
export class CodingTelegramNotifier implements CodingJobNotifier {
    private readonly api: TelegramBotAPI | null;

    constructor(token: string | undefined) {
        this.api = token?.trim() ? createTelegramBotAPI(token.trim()) : null;
    }

    async notify(
        target: CodingTelegramTarget | undefined,
        text: string,
        options: CodingTelegramMessageOptions = {},
    ): Promise<number | undefined> {
        if (!this.api || !target || !Number.isFinite(target.chatId)) {
            return target?.messageId;
        }
        const parts = splitTelegramMessage(text || '...');
        let messageId = target.messageId;
        try {
            if (messageId) {
                const edited = await this.edit(messageId, target.chatId, parts[0], options.keyboard);
                if (!edited) {
                    messageId = (await this.send(target.chatId, parts[0], options.keyboard)) ?? messageId;
                }
            } else {
                messageId = await this.send(target.chatId, parts[0], options.keyboard);
            }
            for (const part of parts.slice(1)) {
                await this.send(target.chatId, part);
            }
        } catch {
            // Progress is advisory; the durable job state remains authoritative.
        }
        return messageId;
    }

    async sendDocument(
        target: CodingTelegramTarget | undefined,
        filename: string,
        content: Uint8Array,
        options: CodingTelegramDocumentOptions = {},
    ): Promise<number | undefined> {
        if (!this.api || !target || !Number.isFinite(target.chatId)) {
            return target?.messageId;
        }
        try {
            const response = await this.api.sendDocument({
                chat_id: target.chatId,
                document: new Blob([content as unknown as ArrayBuffer], { type: 'text/plain' }),
                filename,
                ...(options.caption ? { caption: options.caption.slice(0, 1024) } : {}),
                ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
            } as Telegram.SendDocumentParams);
            if (!response.ok) {
                return undefined;
            }
            const data = (await response.json()) as TelegramResult;
            return data.ok === false ? undefined : data.result?.message_id;
        } catch {
            return undefined;
        }
    }

    private async edit(
        messageId: number,
        chatId: number,
        text: string,
        keyboard: Telegram.InlineKeyboardMarkup | undefined,
    ): Promise<boolean> {
        try {
            const response = await this.api!.editMessageText({
                chat_id: chatId,
                message_id: messageId,
                text,
                ...(keyboard ? { reply_markup: keyboard } : {}),
            });
            if (!response.ok) {
                return false;
            }
            const data = (await response.json()) as TelegramResult;
            return data.ok !== false;
        } catch {
            return false;
        }
    }

    private async send(
        chatId: number,
        text: string,
        keyboard?: Telegram.InlineKeyboardMarkup,
    ): Promise<number | undefined> {
        try {
            const response = await this.api!.sendMessage({
                chat_id: chatId,
                text,
                ...(keyboard ? { reply_markup: keyboard } : {}),
            });
            if (!response.ok) {
                return undefined;
            }
            const data = (await response.json()) as TelegramResult;
            return data.ok === false ? undefined : data.result?.message_id;
        } catch {
            return undefined;
        }
    }
}
