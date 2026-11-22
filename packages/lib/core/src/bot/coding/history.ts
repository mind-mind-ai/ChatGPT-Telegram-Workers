import type { Message } from '@chatgpt-telegram-workers/agent';
import type { CodingChangeSet } from './types';
import type { KVNamespaceBinding } from '@chatgpt-telegram-workers/config';

const HISTORY_PREFIX = 'coding:history:';
const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 60_000;

function encodeKeyPart(value: string): string {
    return encodeURIComponent(value);
}

export function codingHistoryKey(userId: string, chatId: string, sessionId: string): string {
    return `${HISTORY_PREFIX}${encodeKeyPart(chatId)}:${encodeKeyPart(userId)}:${sessionId}`;
}

function textLength(message: Message): number {
    if (typeof message.content === 'string') {
        return message.content.length;
    }
    return message.content.reduce(
        (sum, part) => sum + (part && part.type === 'text' && typeof part.text === 'string' ? part.text.length : 0),
        0,
    );
}

function isMessage(value: unknown): value is Message {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as { role?: unknown; content?: unknown };
    if (candidate.role !== 'user' && candidate.role !== 'assistant' && candidate.role !== 'system') {
        return false;
    }
    return typeof candidate.content === 'string' || Array.isArray(candidate.content);
}

function trimHistory(history: Message[]): Message[] {
    const result = history.filter(isMessage).slice(-MAX_HISTORY_MESSAGES);
    let chars = result.reduce((sum, message) => sum + textLength(message), 0);
    while (result.length > 2 && chars > MAX_HISTORY_CHARS) {
        const removed = result.shift();
        chars -= removed ? textLength(removed) : 0;
    }
    return result;
}

/** Coding history is intentionally separate from the ordinary Telegram chat history. */
export class CodingHistoryStore {
    private readonly ttlSeconds: number;

    constructor(
        private readonly kv: KVNamespaceBinding,
        ttlSeconds = DEFAULT_TTL_SECONDS,
    ) {
        this.ttlSeconds = Math.max(60, Math.trunc(ttlSeconds));
    }

    async load(userId: string, chatId: string, sessionId: string): Promise<Message[]> {
        const raw = await this.kv.get(codingHistoryKey(userId, chatId, sessionId));
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
            return Array.isArray(parsed) ? trimHistory(parsed) : [];
        } catch {
            return [];
        }
    }

    async append(userId: string, chatId: string, sessionId: string, user: Message, assistant: Message): Promise<void> {
        const history = [...(await this.load(userId, chatId, sessionId)), user, assistant];
        await this.kv.put(codingHistoryKey(userId, chatId, sessionId), JSON.stringify(trimHistory(history)), {
            expirationTtl: this.ttlSeconds,
        });
    }

    async clear(userId: string, chatId: string, sessionId: string): Promise<void> {
        await this.kv.delete(codingHistoryKey(userId, chatId, sessionId));
    }
}

const CHANGE_PREFIX = 'coding:changes:';

function encodeChangePart(value: string): string {
    return encodeURIComponent(value);
}

export function codingChangeKey(userId: string, chatId: string, approvalId: string): string {
    return `${CHANGE_PREFIX}${encodeChangePart(chatId)}:${encodeChangePart(userId)}:${encodeChangePart(approvalId)}`;
}

function isChangeSet(value: unknown): value is CodingChangeSet {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const change = value as Partial<CodingChangeSet>;
    return (
        typeof change.repository === 'string' &&
        typeof change.baseRef === 'string' &&
        typeof change.baseCommitSha === 'string' &&
        typeof change.diffHash === 'string' &&
        typeof change.diff === 'string' &&
        typeof change.summary === 'string' &&
        typeof change.createdAt === 'number' &&
        Array.isArray(change.files)
    );
}

/** Stores large proposed change sets outside the Durable Object value limit. */
export class CodingChangeStore {
    private readonly ttlSeconds: number;

    constructor(
        private readonly kv: KVNamespaceBinding,
        ttlSeconds = 30 * 60,
    ) {
        this.ttlSeconds = Math.max(60, Math.trunc(ttlSeconds));
    }

    async save(userId: string, chatId: string, approvalId: string, changeSet: CodingChangeSet): Promise<void> {
        await this.kv.put(codingChangeKey(userId, chatId, approvalId), JSON.stringify(changeSet), {
            expirationTtl: this.ttlSeconds,
        });
    }

    async load(userId: string, chatId: string, approvalId: string): Promise<CodingChangeSet | null> {
        const raw = await this.kv.get(codingChangeKey(userId, chatId, approvalId));
        if (!raw) {
            return null;
        }
        try {
            const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
            return isChangeSet(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    async delete(userId: string, chatId: string, approvalId: string): Promise<void> {
        await this.kv.delete(codingChangeKey(userId, chatId, approvalId));
    }
}
