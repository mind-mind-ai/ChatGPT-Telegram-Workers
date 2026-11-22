import { describe, expect, it } from 'vitest';
import { CodingSessionStore } from './session';
import { MemoryKV, assistantMessage } from './test-helpers';

describe('CodingSessionStore', () => {
    it('creates one active session per user and chat', async () => {
        const kv = new MemoryKV();
        const store = new CodingSessionStore(
            kv,
            () => 1_000,
            1800,
            () => 'session-1',
        );

        const session = await store.create('10', '10', 'octo/repo');
        expect(session).toMatchObject({
            sessionId: 'session-1',
            userId: '10',
            chatId: '10',
            repository: 'octo/repo',
            status: 'initializing',
        });
        expect(kv.ttl.get('coding:session:10:10')).toBe(1800);
        await expect(store.create('10', '10', 'octo/repo')).resolves.toBeNull();
        await expect(store.get('20', '20')).resolves.toBeNull();
        await expect(store.get('10', '11')).resolves.toBeNull();
    });

    it('updates status and refreshes the session expiry', async () => {
        const kv = new MemoryKV();
        let now = 1_000;
        const store = new CodingSessionStore(
            kv,
            () => now,
            1800,
            () => 'session-1',
        );
        const created = (await store.create('10', '10', 'octo/repo'))!;
        now = 2_000;
        const updated = await store.update(created, { status: 'awaiting_input' });
        expect(updated).toMatchObject({ status: 'awaiting_input', updatedAt: 2_000, expiresAt: 1_802_000 });
        expect(store.statusLabel('awaiting_input')).toBe('idle (awaiting input)');
    });

    it('expires sessions and removes their history', async () => {
        const kv = new MemoryKV();
        let now = 1_000;
        const store = new CodingSessionStore(
            kv,
            () => now,
            60,
            () => 'session-1',
        );
        const session = (await store.create('10', '10', 'octo/repo'))!;
        await store.appendHistory(session, { role: 'user', content: 'hello' }, assistantMessage('hi'));
        expect(kv.values.has('coding:history:10:10:session-1')).toBe(true);

        now = 62_000;
        await expect(store.get('10', '10')).resolves.toBeNull();
        expect(kv.values.has('coding:session:10:10')).toBe(false);
        expect(kv.values.has('coding:history:10:10:session-1')).toBe(false);
    });

    it('keeps coding history separate and bounded', async () => {
        const kv = new MemoryKV();
        const store = new CodingSessionStore(
            kv,
            () => 1_000,
            1800,
            () => 'session-1',
        );
        const session = (await store.create('10', '10', 'octo/repo'))!;
        for (let i = 0; i < 50; i++) {
            await store.appendHistory(
                session,
                { role: 'user', content: `question ${i}` },
                { role: 'assistant', content: `answer ${i}` },
            );
        }
        const history = await store.loadHistory(session);
        expect(history.length).toBeLessThanOrEqual(40);
        expect(history.at(-1)).toEqual({ role: 'assistant', content: 'answer 49' });
        expect(kv.values.has('history:10')).toBe(false);
    });

    it('does not let stale cleanup delete a newer session', async () => {
        const kv = new MemoryKV();
        let id = 0;
        const store = new CodingSessionStore(
            kv,
            () => 1_000,
            1800,
            () => `session-${++id}`,
        );
        const old = (await store.create('10', '10', 'octo/repo'))!;
        await store.delete(old);
        const current = (await store.create('10', '10', 'octo/repo'))!;
        await store.delete(old);
        await expect(store.get('10', '10')).resolves.toMatchObject({ sessionId: current.sessionId });
    });

    it('rejects corrupt session records safely', async () => {
        const kv = new MemoryKV();
        const store = new CodingSessionStore(kv, () => 1_000);
        await kv.put('coding:session:10:10', 'not json');
        await expect(store.get('10', '10')).resolves.toBeNull();
        expect(kv.values.has('coding:session:10:10')).toBe(false);
    });
});
