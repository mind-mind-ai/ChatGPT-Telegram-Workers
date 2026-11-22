import type { Message } from '@chatgpt-telegram-workers/agent';
import type { KVNamespaceBinding } from '@chatgpt-telegram-workers/config';
import { CodingHistoryStore } from './history';
import type { CodingSessionState, CodingSessionStatus } from './types';

const SESSION_PREFIX = 'coding:session:';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_TTL_SECONDS = 30 * 60;

function encodeKeyPart(value: string): string {
    return encodeURIComponent(value);
}

function sessionKey(userId: string, chatId: string): string {
    return `${SESSION_PREFIX}${encodeKeyPart(chatId)}:${encodeKeyPart(userId)}`;
}

export class CodingSessionStore {
    private readonly ttlSeconds: number;
    private readonly history: CodingHistoryStore;

    constructor(
        private readonly kv: KVNamespaceBinding,
        private readonly now: () => number = Date.now,
        ttlSeconds = DEFAULT_TTL_SECONDS,
        private readonly idFactory: () => string = () => crypto.randomUUID(),
    ) {
        this.ttlSeconds = Math.max(60, Math.trunc(ttlSeconds));
        this.history = new CodingHistoryStore(kv, this.ttlSeconds);
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
        await this.history.clear(session.userId, session.chatId, session.sessionId);
    }

    async loadHistory(session: CodingSessionState): Promise<Message[]> {
        return this.history.load(session.userId, session.chatId, session.sessionId);
    }

    async appendHistory(session: CodingSessionState, user: Message, assistant: Message): Promise<void> {
        const current = await this.get(session.userId, session.chatId);
        if (!current || current.sessionId !== session.sessionId) {
            return;
        }
        await this.history.append(session.userId, session.chatId, session.sessionId, user, assistant);
    }

    async clearHistory(session: CodingSessionState): Promise<void> {
        await this.history.clear(session.userId, session.chatId, session.sessionId);
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
            await this.history.clear(userId, chatId, session.sessionId);
        }
    }
}
