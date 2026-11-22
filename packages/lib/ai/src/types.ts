import type { ChatProtocol } from './protocols';

// Workers AI 绑定相关类型与平台绑定契约统一放在 @chatgpt-telegram-workers/types,
// 这里再导出以保持本包原有的公开 API。
import type { WorkersAIBinding, WorkersAIModelInfo } from '@chatgpt-telegram-workers/types';

export type { WorkersAIBinding, WorkersAIModelInfo };

export type ImageInput = string | URL | Uint8Array;

export interface TextPart {
    type: 'text';
    text: string;
}

export interface ImagePart {
    type: 'image';
    image: ImageInput;
    mimeType?: string;
}

export type Part = TextPart | ImagePart;

/** Työkalun parametrit JSON Schema -muodossa */
export type ToolParameters = Record<string, unknown>;

/** Mallille tarjottava työkalumääritys */
export interface ToolDefinition {
    name: string;
    description?: string;
    parameters?: ToolParameters;
}

/** Provider-riippumaton työkalukutsu;argumentit aina JSON-merkkijonona */
export interface ToolCall {
    id: string;
    name: string;
    arguments: string;
}

/** Työkalun tulos, joka lähetetään takaisin mallille */
export interface ToolResult {
    toolCallId: string;
    content: string;
    isError?: boolean;
}

/** Työkalun valintatapa;nimetty valinta pakottaa tietyn työkalun */
export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'tool'; name: string };

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
    role: Role;
    content: string | Part[];
    /** assistant-viestin työkalukutsut */
    toolCalls?: ToolCall[];
    /** tool-viestin vastaavan kutsun id */
    toolCallId?: string;
    /** tool-viestin työkalun nimi (valinnainen) */
    name?: string;
    /** tool-viestin virhelippu */
    isError?: boolean;
}

export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}

export interface CompletionOptions {
    model: string;
    messages: Message[];
    system?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stop?: string | string[];
    signal?: AbortSignal;
    headers?: Record<string, string>;
    extra?: Record<string, unknown>;
    tools?: ToolDefinition[];
    toolChoice?: ToolChoice;
}

export interface CompletionResult {
    text: string;
    usage?: Usage;
    stopReason?: string | null;
    /** Mallin pyytämät työkalukutsut;tyhjä tai puuttuva, jos malli vastasi suoraan */
    toolCalls?: ToolCall[];
}

/** 聊天协议标识(与 protocols.ts 的 ChatProtocol 同一来源) */
export type Protocol = ChatProtocol;

/**
 * 需要 multipart 信封的图片输入(flux-2 系列等)。
 * `body` 是 FormData 编码后的流,`contentType` 必须带上与之一致的 boundary,
 * 否则 Cloudflare 会以 5006 "required properties at '/' are 'multipart'" 拒绝。
 *
 * 必须是 type 而非 interface:interface 没有隐式索引签名,无法赋给官方 `Ai.run`
 * 兜底重载的 `Record<string, unknown>` 参数。
 */
export type WorkersImageMultipartInput = {
    multipart: {
        body: ReadableStream<Uint8Array>;
        contentType?: string | null;
    };
};

/** 扁平的图片生成参数,至少含 prompt */
export type WorkersImageParams = { prompt: string } & Record<string, unknown>;

/**
 * 图片生成输入:
 * - 普通模型是扁平的生成参数(至少含 prompt);
 * - 输入 schema 要求 `multipart` 的模型必须用信封包裹(见上)。
 */
export type WorkersImageInput = WorkersImageParams | WorkersImageMultipartInput;

/** 图片传输方式:URL 直传,或抓取后内联为 base64 */
export type ImageTransfer = 'url' | 'base64';

export interface ClientConfig {
    apiKey?: string;
    /** 自定义携带 API Key 的请求头名(缺省按协议内置:Bearer / x-api-key);Azure 用 `api-key` */
    apiKeyHeader?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    fetch?: typeof fetch;
    /** 图片传输方式,仅对同时支持 URL 与 base64 的协议生效(见 protocols.ts 的 chatImageSupport) */
    imageTransfer?: ImageTransfer;
    /** workers 协议:Cloudflare 账号 id,用于拼接 REST 端点 */
    accountId?: string;
    /** workers 协议:优先使用的 AI 绑定,缺省时回退到 REST */
    binding?: WorkersAIBinding;
}

export interface LLMClient {
    readonly protocol: Protocol;
    complete: (options: CompletionOptions) => Promise<CompletionResult>;
    stream: (options: CompletionOptions) => AsyncIterable<string>;
}

export interface SSEParseResult {
    delta?: string;
    finish?: boolean;
    error?: string;
}
