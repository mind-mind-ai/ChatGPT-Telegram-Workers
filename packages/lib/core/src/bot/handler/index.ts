import type * as Telegram from 'telegram-bot-api-types';
import type { UpdateHandler } from './types';
import { ENV } from '@chatgpt-telegram-workers/config';
import { configureTelegram, Update2MessageHandler } from '@chatgpt-telegram-workers/telegram';
import { WorkerContext } from '../context';
import { GroupMention } from './group';
import { CodingCallbackHandler, CodingMessageHandler } from './coding';
import {
    AccessFilter,
    CallbackQueryHandler,
    ChatHandler,
    CommandHandler,
    EnvChecker,
    MessageFilter,
    OldMessageFilter,
    SaveLastMessage,
    ServiceMessageFilter,
} from './handlers';

// 消息处理中间件
const SHARE_HANDLER: UpdateHandler[] = [
    // 服务消息(入群/退群/置顶等)不是用户输入,最先忽略,避免被白名单等中间件误回复
    new ServiceMessageFilter(),
    // 检查环境是否准备好: DATABASE
    new EnvChecker(),
    // 过滤非白名单用户, 提前过滤减少KV消耗
    new AccessFilter(),
    // InlineKeyboard 回调(/models 切换模型等),必须在消息转换之前接管
    new CodingCallbackHandler(),
    new CallbackQueryHandler(),
    // 消息处理
    new Update2MessageHandler([
        // 过滤不支持的消息(抛出异常结束消息处理)
        new MessageFilter(),
        // 处理群消息，判断是否需要响应此条消息
        new GroupMention(),
        // 忽略旧消息
        new OldMessageFilter(),
        // DEBUG: 保存最后一条消息,按照需求自行调整此中间件位置
        new SaveLastMessage(),
        // 处理命令消息
        new CommandHandler(),
        // 有活动编码会话时,普通文本进入编码代理而不是普通聊天历史
        new CodingMessageHandler(),
        // 与llm聊天
        new ChatHandler(),
    ]),
];

function isTokenConfigurationError(error: unknown): boolean {
    return error instanceof Error && error.message === 'Token not allowed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasValidChat(chat: unknown): boolean {
    return isRecord(chat) && typeof chat.id === 'number' && chat.id !== 0 && typeof chat.type === 'string';
}

type InvalidUpdateReason = 'invalid-chat' | 'invalid-context';

function classifyInvalidUpdate(update: Telegram.Update): InvalidUpdateReason | null {
    if (!isRecord(update)) {
        return 'invalid-context';
    }
    if (update.message !== undefined) {
        return isRecord(update.message) && hasValidChat(update.message.chat) ? null : 'invalid-chat';
    }
    if (isRecord(update.callback_query)) {
        const callback = update.callback_query;
        if (!isRecord(callback.from) || typeof callback.from.id !== 'number') {
            return 'invalid-context';
        }
        return isRecord(callback.message) && hasValidChat(callback.message.chat) ? null : 'invalid-chat';
    }
    return 'invalid-context';
}

export async function handleUpdate(token: string, update: Telegram.Update): Promise<Response | null> {
    // 载入全局配置并把宿主环境注入传输层框架
    await ENV.loadConfig();
    configureTelegram({
        apiDomain: ENV.CONFIG.settings.telegramApiDomain,
        defaultParseMode: ENV.CONFIG.settings.defaultParseMode,
        renderMessage: ENV.CUSTOM_MESSAGE_RENDER,
    });

    const invalidReason = classifyInvalidUpdate(update);
    if (invalidReason) {
        // Excludes token, message text, sender data, and callback data.
        console.warn('[telegram] ignored invalid update', { reason: invalidReason });
        return null;
    }

    let context: WorkerContext;
    try {
        context = WorkerContext.from(token, update);
    } catch (error) {
        if (isTokenConfigurationError(error)) {
            // Fixed reason only; never include the supplied token or env values.
            console.warn('[telegram] rejected update', { reason: 'token-not-allowed' });
            return new Response('Forbidden', { status: 403 });
        }
        throw error;
    }

    for (const handler of SHARE_HANDLER) {
        try {
            const result = await handler.handle(update, context);
            if (result) {
                return result;
            }
        } catch (e) {
            return new Response(
                JSON.stringify({
                    message: (e as Error).message,
                    stack: (e as Error).stack,
                }),
                { status: 500 },
            );
        }
    }
    return null;
}
