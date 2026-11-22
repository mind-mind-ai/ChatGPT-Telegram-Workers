import type * as Telegram from 'telegram-bot-api-types';
import { ENV, cloneDefaultConfig } from '@chatgpt-telegram-workers/config';
import { ChatHandler, MessageFilter } from './handlers';

vi.mock('../chat', () => ({
    chatWithAttachments: vi.fn(async () => new Response('attachment')),
    chatWithMessage: vi.fn(async () => new Response('chat')),
    extractUserMessageItem: vi.fn(async () => ({ role: 'user', content: 'hello' })),
}));

import * as chat from '../chat';

function message(overrides: Partial<Telegram.Message> = {}): Telegram.Message {
    return {
        message_id: 1,
        date: 1700000000,
        chat: { id: 10, type: 'private' },
        from: { id: 20, is_bot: false, first_name: 'User' },
        ...overrides,
    } as Telegram.Message;
}

const PDF_DOCUMENT = {
    file_id: 'pdf-1',
    file_unique_id: 'u1',
    file_name: 'report.pdf',
    mime_type: 'application/pdf',
};

beforeEach(() => {
    ENV.CONFIG = cloneDefaultConfig();
    vi.clearAllMocks();
});

describe('MessageFilter', () => {
    it('accepts documents without a caption', async () => {
        await expect(new MessageFilter().handle(message({ document: PDF_DOCUMENT }), {} as any)).resolves.toBeNull();
    });

    it('still rejects messages without supported content', async () => {
        await expect(new MessageFilter().handle(message(), {} as any)).rejects.toThrow('Not supported message type');
    });
});

describe('ChatHandler attachment routing', () => {
    it('routes a document to the attachment flow', async () => {
        const handler = new ChatHandler();
        await handler.handle(message({ document: PDF_DOCUMENT }), {} as any);
        expect(chat.chatWithAttachments).toHaveBeenCalledTimes(1);
        expect(chat.chatWithMessage).not.toHaveBeenCalled();
    });

    it('routes a reply-to document to the attachment flow', async () => {
        const handler = new ChatHandler();
        await handler.handle(
            message({ text: 'Summarize this', reply_to_message: message({ document: PDF_DOCUMENT }) }),
            {} as any,
        );
        expect(chat.chatWithAttachments).toHaveBeenCalledTimes(1);
    });

    it('falls back to text chat when the replied-to document came from a bot', async () => {
        const handler = new ChatHandler();
        await handler.handle(
            message({
                text: 'what did you send?',
                reply_to_message: message({
                    from: { id: 99, is_bot: true, first_name: 'Bot' },
                    document: PDF_DOCUMENT,
                }),
            }),
            {} as any,
        );
        expect(chat.chatWithAttachments).not.toHaveBeenCalled();
        expect(chat.chatWithMessage).toHaveBeenCalledTimes(1);
    });

    it('keeps plain text on the streaming chat path', async () => {
        const handler = new ChatHandler();
        await handler.handle(message({ text: 'hello' }), {} as any);
        expect(chat.chatWithAttachments).not.toHaveBeenCalled();
        expect(chat.chatWithMessage).toHaveBeenCalledTimes(1);
    });

    it('does not attach a reply-to photo unless extra context is enabled', async () => {
        const handler = new ChatHandler();
        const photoMessage = message({
            text: 'what is this?',
            reply_to_message: message({
                photo: [{ file_id: 'photo-1', file_unique_id: 'p1', width: 10, height: 10 }],
            }),
        });
        await handler.handle(photoMessage, {} as any);
        expect(chat.chatWithAttachments).not.toHaveBeenCalled();
        expect(chat.chatWithMessage).toHaveBeenCalledTimes(1);

        ENV.CONFIG.settings.extraMessageContext = true;
        await handler.handle(photoMessage, {} as any);
        expect(chat.chatWithAttachments).toHaveBeenCalledTimes(1);
    });
});
