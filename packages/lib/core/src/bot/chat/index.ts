import type { ChatAgent, HistoryModifier, Message, Part, StreamHandler } from '@chatgpt-telegram-workers/agent';
import type * as Telegram from 'telegram-bot-api-types';
import type { WorkerContext } from '../context';
import {
    chatImageSupport,
    DocumentStore,
    loadChatLLM,
    registerDocumentTools,
    registerWebTools,
    requestAgentCompletionsFromLLM,
    requestCompletionsFromLLM,
    ToolRegistry,
} from '@chatgpt-telegram-workers/agent';
import { ENV } from '@chatgpt-telegram-workers/config';
import { createTelegramBotAPI, MessageSender } from '@chatgpt-telegram-workers/telegram';
import { AttachmentError, buildAttachmentUserMessage, detectAttachments, prepareAttachments } from './attachments';

export async function chatWithMessage(
    message: Telegram.Message,
    params: Message | null,
    context: WorkerContext,
    modifier: HistoryModifier | null,
): Promise<Response> {
    const sender = MessageSender.fromMessage(context.SHARE_CONTEXT.botToken, message);
    try {
        try {
            const msg = (await sender.sendPlainText('...').then(r => r.json())) as Telegram.ResponseWithMessage;
            sender.update({
                message_id: msg.result.message_id,
            });
        } catch (e) {
            console.error(e);
        }
        const api = createTelegramBotAPI(context.SHARE_CONTEXT.botToken);
        setTimeout(
            () =>
                api
                    .sendChatAction({
                        chat_id: message.chat.id,
                        action: 'typing',
                    })
                    .catch(console.error),
            0,
        );
        let onStream: StreamHandler | null = null;
        let nextEnableTime: number | null = null;
        if (ENV.CONFIG.settings.streamMode) {
            onStream = async (text: string): Promise<any> => {
                try {
                    // 判断是否需要等待
                    if (nextEnableTime && nextEnableTime > Date.now()) {
                        return;
                    }
                    const resp = await sender.sendPlainText(text);
                    // 判断429
                    if (resp.status === 429) {
                        // 获取重试时间
                        const retryAfter = Number.parseInt(resp.headers.get('Retry-After') || '');
                        if (retryAfter) {
                            nextEnableTime = Date.now() + retryAfter * 1000;
                            return;
                        }
                    }
                    nextEnableTime = null;
                    if (resp.ok) {
                        const respJson = (await resp.json()) as Telegram.ResponseWithMessage;
                        sender.update({
                            message_id: respJson.result.message_id,
                        });
                    }
                } catch (e) {
                    console.error(e);
                }
            };
        }

        const agent = loadChatLLM(ENV.CONFIG);
        if (agent === null) {
            return sender.sendPlainText('LLM is not enable');
        }
        const answer = await requestCompletionsFromLLM(
            params,
            context.SHARE_CONTEXT.chatHistoryKey,
            ENV.CONFIG,
            agent,
            modifier,
            onStream,
        );
        if (nextEnableTime !== null && nextEnableTime > Date.now()) {
            await new Promise(resolve => setTimeout(resolve, (nextEnableTime ?? 0) - Date.now()));
        }
        return sender.sendRichText(answer);
    } catch (e) {
        let errMsg = `Error: ${(e as Error).message}`;
        if (errMsg.length > 2048) {
            // 裁剪错误信息 最长2048
            errMsg = errMsg.substring(0, 2048);
        }
        return sender.sendPlainText(errMsg);
    }
}

const IMAGE_UNSUPPORTED_MESSAGE =
    'The selected chat model does not support image input. Choose a vision-capable provider.';

function supportsImageInput(agent: ChatAgent): boolean {
    const provider = ENV.CONFIG.chatProviders.find(item => item.id === agent.name);
    return provider ? chatImageSupport(provider.protocol) !== 'none' : false;
}

/**
 * Attachment flow: documents and images are prepared before the agent run.
 * It is intentionally non-streaming, while plain text chat keeps streaming.
 */
export async function chatWithAttachments(message: Telegram.Message, context: WorkerContext): Promise<Response> {
    const sender = MessageSender.fromMessage(context.SHARE_CONTEXT.botToken, message);
    try {
        try {
            const msg = (await sender.sendPlainText('...').then(r => r.json())) as Telegram.ResponseWithMessage;
            sender.update({ message_id: msg.result.message_id });
        } catch (e) {
            console.error(e);
        }

        const api = createTelegramBotAPI(context.SHARE_CONTEXT.botToken);
        setTimeout(
            () =>
                api
                    .sendChatAction({
                        chat_id: message.chat.id,
                        action: 'typing',
                    })
                    .catch(console.error),
            0,
        );

        const agent = loadChatLLM(ENV.CONFIG);
        if (!agent) {
            return sender.sendPlainText('LLM is not enable');
        }

        const inputs = detectAttachments(message);
        if (inputs.length === 0) {
            return sender.sendPlainText('No supported attachment found');
        }
        if (inputs.some(input => input.kind === 'image') && !supportsImageInput(agent)) {
            return sender.sendPlainText(IMAGE_UNSUPPORTED_MESSAGE);
        }

        const store = new DocumentStore();
        const prepared = await prepareAttachments(inputs, context.SHARE_CONTEXT.botToken, store);
        if (prepared.some(item => item.image) && !supportsImageInput(agent)) {
            return sender.sendPlainText(IMAGE_UNSUPPORTED_MESSAGE);
        }
        const userMessage = buildAttachmentUserMessage(prepared, message.caption || message.text);

        const registry = new ToolRegistry();
        registerWebTools(registry);
        if (prepared.some(item => item.document)) {
            registerDocumentTools(registry, store);
        }

        const permissions = ['web', ...(prepared.some(item => item.document) ? ['documents'] : [])];
        const result = await requestAgentCompletionsFromLLM(
            userMessage,
            context.SHARE_CONTEXT.chatHistoryKey,
            ENV.CONFIG,
            agent,
            registry,
            {
                access: {
                    userId: `${message.from?.id ?? message.chat.id}`,
                    chatId: `${message.chat.id}`,
                    permissions,
                },
                maxSteps: 8,
                timeoutMs: 60_000,
                toolTimeoutMs: 30_000,
            },
        );

        return sender.sendRichText(result.text || 'The model returned an empty response.');
    } catch (e) {
        if (e instanceof AttachmentError) {
            return sender.sendPlainText(`Attachment error: ${e.message}`);
        }
        let errMsg = `Error: ${(e as Error).message}`;
        if (errMsg.length > 2048) {
            errMsg = errMsg.substring(0, 2048);
        }
        return sender.sendPlainText(errMsg);
    }
}

export async function extractImageURL(fileId: string | null, context: WorkerContext): Promise<URL | null> {
    if (!fileId) {
        return null;
    }
    const api = createTelegramBotAPI(context.SHARE_CONTEXT.botToken);
    const file = await api.getFileWithReturns({ file_id: fileId });
    const filePath = file.result.file_path;
    if (filePath) {
        const url = URL.parse(
            `${ENV.CONFIG.settings.telegramApiDomain}/file/bot${context.SHARE_CONTEXT.botToken}/${filePath}`,
        );
        if (url) {
            return url;
        }
    }
    return null;
}

export function extractImageFileID(message: Telegram.Message): string | null {
    if (message.photo && message.photo.length > 0) {
        const offset = ENV.CONFIG.settings.telegramPhotoSizeOffset;
        const length = message.photo.length;
        const sizeIndex = Math.max(0, Math.min(offset >= 0 ? offset : length + offset, length - 1));
        return message.photo[sizeIndex]?.file_id;
    } else if (message.document && message.document.thumbnail) {
        return message.document.thumbnail.file_id;
    }
    return null;
}

export async function extractUserMessageItem(message: Telegram.Message, context: WorkerContext): Promise<Message> {
    const settings = ENV.CONFIG.settings;
    let text = message.text || message.caption || '';
    const urls = await extractImageURL(extractImageFileID(message), context).then(u => (u ? [u] : []));
    if (
        settings.extraMessageContext &&
        message.reply_to_message &&
        message.reply_to_message.from &&
        `${message.reply_to_message.from.id}` !== `${context.SHARE_CONTEXT.botId}` // ignore bot reply
    ) {
        const extraText = message.reply_to_message.text || message.reply_to_message.caption || '';
        if (extraText) {
            text = `${text}\nThe following is the referenced context: ${extraText}`;
        }
        if (settings.extraMessageMediaCompatible.includes('image') && message.reply_to_message.photo) {
            const url = await extractImageURL(extractImageFileID(message.reply_to_message), context);
            if (url) {
                urls.push(url);
            }
        }
    }
    const params: Message = {
        role: 'user',
        content: text,
    };
    if (urls.length > 0) {
        const contents = new Array<Part>();
        if (text) {
            contents.push({ type: 'text', text });
        }
        for (const url of urls) {
            contents.push({ type: 'image', image: url });
        }
        params.content = contents;
    }
    return params;
}
