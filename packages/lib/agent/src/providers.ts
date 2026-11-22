import type {
    ClientConfig,
    CompletionOptions,
    Message,
    ToolChoice,
    ToolDefinition,
} from '@chatgpt-telegram-workers/ai';
import type { AppSettings, ChatProviderConfig, ImageProviderConfig } from '@chatgpt-telegram-workers/config';
import type { ChatAgent, ImageAgent } from './types';
import { createClient, createImageClient, findChatProtocol } from '@chatgpt-telegram-workers/ai';
import { AgentRuntime } from './runtime';
import { consumeTextStream } from './stream';

/** 走 HTTP 客户端的聊天协议(workers 有独立入口) */
export type HttpChatProtocol = 'chat-completions' | 'anthropic-messages' | 'responses';

/**
 * 按 `chatCompleteApiTimeout`(秒,<=0 表示不限)创建超时控制器。
 * 返回 clear,调用方在请求结束后必须清理,避免定时器泄漏。
 */
export function chatAbortSignal(
    settings: AppSettings,
    parent?: AbortSignal,
): { signal?: AbortSignal; clear: () => void } {
    const timeoutMs = settings.chatCompleteApiTimeout;
    if (timeoutMs <= 0 && !parent) {
        return { clear: () => {} };
    }
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parent?.reason);
    if (parent) {
        if (parent.aborted) {
            controller.abort(parent.reason);
        } else {
            parent.addEventListener('abort', abortFromParent, { once: true });
        }
    }
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs * 1000) : undefined;
    return {
        signal: controller.signal,
        clear: () => {
            if (timer) {
                clearTimeout(timer);
            }
            parent?.removeEventListener('abort', abortFromParent);
        },
    };
}

function buildChatOptions(
    provider: ChatProviderConfig,
    settings: AppSettings,
    messages: Message[],
    signal: AbortSignal | undefined,
    tools?: ToolDefinition[],
    toolChoice?: ToolChoice,
    system?: string,
): CompletionOptions {
    const extra = provider.extraParams ?? {};
    return {
        model: provider.model,
        system: (system ?? settings.systemInitMessage) || undefined,
        messages,
        signal,
        ...(settings.maxOutputTokens > 0 ? { maxTokens: settings.maxOutputTokens } : {}),
        ...(Object.keys(extra).length ? { extra } : {}),
        ...(tools?.length ? { tools } : {}),
        ...(tools?.length && toolChoice ? { toolChoice } : {}),
    };
}

/** 从 provider.options 读取 API Key 的自定义请求头名(Azure 用 `api-key`) */
function apiKeyHeader(provider: ChatProviderConfig): string | undefined {
    const value = provider.options?.apiKeyHeader;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clientConfig(provider: ChatProviderConfig, settings: AppSettings): ClientConfig {
    return {
        baseUrl: provider.baseUrl || undefined,
        apiKey: provider.apiKey || undefined,
        apiKeyHeader: apiKeyHeader(provider),
        // 仅对同时支持 URL 与 base64 的协议生效;anthropic 恒内联、workers 恒剥离,由 ai 客户端按协议能力决定
        imageTransfer: settings.telegramImageTransferMode,
    };
}

/** 按协议与实例组装走 HTTP 的聊天 agent(workers 走 workersai.ts) */
export function createChatAgent(
    protocol: HttpChatProtocol,
    provider: ChatProviderConfig,
    settings: AppSettings,
): ChatAgent {
    const client = createClient(protocol, clientConfig(provider, settings));
    const runtime = new AgentRuntime(async request => {
        const { signal, clear } = chatAbortSignal(settings, request.signal);
        const options = buildChatOptions(
            provider,
            settings,
            request.messages,
            signal,
            request.tools,
            request.toolChoice,
            request.system,
        );
        try {
            return await client.complete(options);
        } finally {
            clear();
        }
    });
    return {
        name: provider.id,
        label: provider.label || findChatProtocol(protocol)?.label || protocol,
        model: provider.model || provider.models[0] || '',
        modelList: async () => provider.models,
        supportsTools: true,
        chat: async (messages, onStream) => {
            const { signal, clear } = chatAbortSignal(settings);
            const options = buildChatOptions(provider, settings, messages, signal);
            try {
                if (onStream) {
                    return await consumeTextStream(
                        client.stream(options),
                        onStream,
                        settings.telegramMinStreamInterval,
                    );
                }
                return (await client.complete(options)).text;
            } finally {
                clear();
            }
        },
        completeWithTools: (messages, tools, options) => runtime.run(messages, tools, options),
    };
}

/** 组装 OpenAI Images 协议的图片 agent(workers 走 workersai.ts) */
export function createImageAgent(provider: ImageProviderConfig): ImageAgent {
    const client = createImageClient('images', {
        model: provider.model,
        baseUrl: provider.baseUrl || undefined,
        apiKey: provider.apiKey || undefined,
        extraParams: provider.extraParams,
    });
    return {
        name: provider.id,
        label: provider.label || 'OpenAI Images',
        model: provider.model || provider.models[0] || '',
        modelList: async () => provider.models,
        generate: prompt => client.generate(prompt),
    };
}
