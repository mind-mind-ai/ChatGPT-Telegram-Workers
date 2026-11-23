import { matchTelegramHook } from '@chatgpt-telegram-workers/core';
import { describe, expect, it } from 'vitest';
import { isCodingUpdate, isTelegramWebhookPath } from './free-test-guard';

describe('free-test webhook routing', () => {
    it('matches every path accepted by the shared application router', () => {
        const accepted = [
            '/telegram/123/webhook',
            '/telegram/123/webhook/',
            '/telegram/123/webhook//',
            '//telegram/123/webhook',
            '///telegram/123/webhook',
            '/telegram/123/safehook',
            '/telegram/123/safehook/',
        ];
        for (const pathname of accepted) {
            expect(matchTelegramHook(pathname)).not.toBeNull();
            expect(isTelegramWebhookPath(pathname)).toBe(true);
        }
    });

    it('rejects non-webhook and malformed paths', () => {
        for (const pathname of [
            '/telegram/123/notwebhook',
            '/telegram/123/webhook/extra',
            '/telegram/123',
            '/rpc',
            '/telegram/%/webhook',
        ]) {
            expect(matchTelegramHook(pathname)).toBeNull();
            expect(isTelegramWebhookPath(pathname)).toBe(false);
        }
    });
});

describe('free-test coding guard', () => {
    it('blocks coding commands in message text and captions', () => {
        for (const text of ['/code', '/code_status', '/code_stop', '/code@test_bot', ' /code ']) {
            expect(isCodingUpdate({ message: { text } })).toBe(true);
            expect(isCodingUpdate({ message: { caption: text } })).toBe(true);
        }
    });

    it('blocks coding commands in edited, channel and business updates', () => {
        for (const field of [
            'edited_message',
            'channel_post',
            'edited_channel_post',
            'business_message',
            'edited_business_message',
        ]) {
            expect(isCodingUpdate({ [field]: { text: '/code' } })).toBe(true);
        }
    });

    it('blocks coding callbacks only', () => {
        expect(isCodingUpdate({ callback_query: { data: 'code:repo:0' } })).toBe(true);
        expect(isCodingUpdate({ callback_query: { data: 'code:approve:1:nonce' } })).toBe(true);
        expect(isCodingUpdate({ callback_query: { data: 'm:0:0' } })).toBe(false);
        expect(isCodingUpdate({ callback_query: { data: 123 } })).toBe(false);
    });

    it('preserves normal text, commands and malformed-safe values', () => {
        for (const update of [
            { message: { text: '/start' } },
            { message: { text: '/models' } },
            { message: { text: '/admin' } },
            { message: { text: 'hello' } },
            { message: { caption: 'hello' } },
            { message: { text: '/codefoo' } },
            { message: { text: 'hello /code' } },
            { message: { text: 123 } },
            null,
            [],
            {},
        ]) {
            expect(isCodingUpdate(update)).toBe(false);
        }
    });
});
