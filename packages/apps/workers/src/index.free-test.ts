import { createApp, ENV } from '@chatgpt-telegram-workers/core';
import { isCodingUpdate, isTelegramWebhookPath } from './free-test-guard';

const app = createApp({
    onRequest: env => {
        ENV.merge((env as Record<string, any>) ?? {});
    },
});

const UPDATE_FIELDS = [
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'business_message',
    'edited_business_message',
    'callback_query',
] as const;

function updateKind(value: unknown): string {
    if (!value || typeof value !== 'object') {
        return 'unknown';
    }
    const update = value as Record<string, unknown>;
    return UPDATE_FIELDS.find(field => update[field] !== undefined) ?? 'unknown';
}

/** Never include tokens, paths, message text, callback data, or sender details. */
function logRejected(reason: string, update?: unknown): void {
    console.warn('[free-test] telegram update rejected', { reason, updateType: updateKind(update) });
}

/**
 * Free-plan test entrypoint: no SandboxDurableObject export and no Containers.
 * Coding commands and approval callbacks are rejected at the webhook boundary.
 */
export default {
    async fetch(request: Request, env?: unknown): Promise<Response> {
        if (request.method === 'POST' && isTelegramWebhookPath(new URL(request.url).pathname)) {
            let update: unknown;
            try {
                update = await request.clone().json();
            } catch {
                logRejected('invalid-json');
                // Let the application return its normal response for malformed updates.
                return app.fetch(request, env);
            }
            if (isCodingUpdate(update)) {
                logRejected('coding-command-or-callback', update);
                return new Response('OK', { status: 200 });
            }
        }
        return app.fetch(request, env);
    },
};

export { CodingSessionDurableObject } from '@chatgpt-telegram-workers/core';
