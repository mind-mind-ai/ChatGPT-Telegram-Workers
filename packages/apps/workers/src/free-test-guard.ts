/**
 * Test-only ingress guard for the Containers-free Worker.
 *
 * The shared application registers coding commands unconditionally. This guard
 * keeps those commands from reaching the application on the free-test Worker,
 * while leaving the production entrypoint untouched.
 */

import { isCodingCommandText, matchTelegramHook } from '@chatgpt-telegram-workers/core';

const UPDATE_MESSAGE_FIELDS = [
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'business_message',
    'edited_business_message',
] as const;

function hasCodingCommandText(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const message = value as Record<string, unknown>;
    return ['text', 'caption'].some(key => isCodingCommandText(message[key]));
}

export function isCodingUpdate(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const update = value as Record<string, unknown>;
    if (UPDATE_MESSAGE_FIELDS.some(field => hasCodingCommandText(update[field]))) {
        return true;
    }
    const callback = update.callback_query;
    if (callback && typeof callback === 'object') {
        const data = (callback as Record<string, unknown>).data;
        return typeof data === 'string' && data.startsWith('code:');
    }
    return false;
}

export function isTelegramWebhookPath(pathname: string): boolean {
    return matchTelegramHook(pathname) !== null;
}
