import type { Message } from '@chatgpt-telegram-workers/agent';
import type { KVNamespaceBinding } from '@chatgpt-telegram-workers/config';
import type { CodingSessionState, CodingSessionStatus } from './types';

const SESSION_PREFIX = 'coding:session:';
const HISTORY_PREFIX = 'coding:history:';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 60_000;

function encodeKeyPart(value: string): string {
    return encodeURIComponent(value);
}

function sessionKey(userId: string, chatId: string): string {
    return `${SESSION_PREFIX}${encodeKeyPart(chatId)}:${encodeKeyPart(userId)}`;
}

function historyKey(session: CodingSessionState): string {
    return `${HISTORY_PREFIX}${encodeKeyPart(session.chatId)}:${encodeKeyPart(session.userId)}:${session.sessionId}`;
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
    let result = history.filter(isMessage).slice(-MAX_HISTORY_MESSAGES);
    let chars = result.reduce((sum, message) => sum + textLength(message), 0);
    while (result.length > 2 && chars > MAX_HISTORY_CHARS) {
        const removed = result.shift();
        chars -= removed ? textLength(removed) : 0;
    }
    return result;
}

export class CodingSessionStore {
    private readonly ttlSeconds: number;

    constructor(
        private readonly kv: KVNamespaceBinding,
        private readonly now: () => number = Date.now,
        ttlSeconds = DEFAULT_TTL_SECONDS,
        private readonly idFactory: () => string = () => crypto.randomUUID(),
    ) {
        this.ttlSeconds = Math.max(60, Math.trunc(ttlSeconds));
    }

    async get(userId: string, chatId: string): Promise<CodingSessionState | null> {
        const raw = await this.kv.get(sessionKey(userId, chatId));
        if (!raw) {
            return null;
        }
        let session: CodingSessionState;
        try {
            session = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as CodingSessionState;
        } catch {
            await this.kv.delete(sessionKey(userId, chatId));
            return null;
        }
        if (
            !session ||
            session.version !== 1 ||
            typeof session.userId !== 'string' ||
            typeof session.chatId !== 'string' ||
            typeof session.sessionId !== 'string' ||
            typeof session.repository !== 'string' ||
            session.userId !== userId ||
            session.chatId !== chatId ||
            !SESSION_ID_PATTERN.test(session.sessionId) ||
            !USER_ID_PATTERN.test(session.userId) ||
            !USER_ID_PATTERN.test(session.chatId) ||
            !REPOSITORY_PATTERN.test(session.repository) ||
            !['initializing', 'awaiting_input', 'running'].includes(session.status) ||
            typeof session.expiresAt !== 'number' ||
            !Number.isFinite(session.expiresAt) ||
            session.expiresAt <= this.now()
        ) {
            await this.deleteStored(userId, chatId, session);
            return null;
        }
        return session;
    }

    async create(userId: string, chatId: string, repository: string): Promise<CodingSessionState | null> {
        if (await this.get(userId, chatId)) {
            return null;
        }
        const createdAt = this.now();
        const session: CodingSessionState = {
            version: 1,
            sessionId: this.idFactory(),
            userId,
            chatId,
            repository: repository.toLowerCase(),
            status: 'initializing',
            createdAt,
            updatedAt: createdAt,
            expiresAt: createdAt + this.ttlSeconds * 1000,
        };
        if (!SESSION_ID_PATTERN.test(session.sessionId)) {
            throw new Error('Generated coding session id is invalid');
        }
        await this.put(session);
        return session;
    }

    async update(
        session: CodingSessionState,
        patch: Partial<Pick<CodingSessionState, 'status'>>,
    ): Promise<CodingSessionState | null> {
        const current = await this.get(session.userId, session.chatId);
        if (!current || current.sessionId !== session.sessionId) {
            return null;
        }
        const updatedAt = this.now();
        const next: CodingSessionState = {
            ...current,
            ...patch,
            updatedAt,
            expiresAt: updatedAt + this.ttlSeconds * 1000,
        };
        await this.put(next);
        return next;
    }

    async delete(session: CodingSessionState): Promise<void> {
        const current = await this.get(session.userId, session.chatId);
        // A stale cleanup must never remove a newer session that replaced this one.
        if (current && current.sessionId !== session.sessionId) {
            return;
        }
        await this.kv.delete(sessionKey(session.userId, session.chatId));
        await this.kv.delete(historyKey(session));
    }

    async loadHistory(session: CodingSessionState): Promise<Message[]> {
        const raw = await this.kv.get(historyKey(session));
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

    async appendHistory(session: CodingSessionState, user: Message, assistant: Message): Promise<void> {
        const current = await this.get(session.userId, session.chatId);
        if (!current || current.sessionId !== session.sessionId) {
            return;
        }
        const history = [...(await this.loadHistory(session)), user, assistant];
        await this.kv.put(historyKey(session), JSON.stringify(trimHistory(history)), {
            expirationTtl: this.ttlSeconds,
        });
    }

    async clearHistory(session: CodingSessionState): Promise<void> {
        await this.kv.delete(historyKey(session));
    }

    statusLabel(status: CodingSessionStatus): string {
        switch (status) {
            case 'initializing':
                return 'starting';
            case 'running':
                return 'running';
            case 'awaiting_input':
                return 'idle (awaiting input)';
        }
    }

    private async put(session: CodingSessionState): Promise<void> {
        await this.kv.put(sessionKey(session.userId, session.chatId), JSON.stringify(session), {
            expirationTtl: this.ttlSeconds,
        });
    }

    private async deleteStored(
        userId: string,
        chatId: string,
        session: Partial<CodingSessionState> | null,
    ): Promise<void> {
        await this.kv.delete(sessionKey(userId, chatId));
        if (session?.sessionId && SESSION_ID_PATTERN.test(session.sessionId)) {
            await this.kv.delete(
                `${HISTORY_PREFIX}${encodeKeyPart(chatId)}:${encodeKeyPart(userId)}:${session.sessionId}`,
            );
        }
    }
}
