import { createApp, ENV } from '@chatgpt-telegram-workers/core';
import { isCodingUpdate, isTelegramWebhookPath } from './free-test-guard';

const app = createApp({
    onRequest: env => {
        ENV.merge((env as Record<string, any>) ?? {});
    },
});

/**
 * Free-plan test entrypoint: no SandboxDurableObject export and no Containers.
 * Coding commands and approval callbacks are rejected at the webhook boundary.
 */
export default {
    async fetch(request: Request, env?: unknown): Promise<Response> {
        if (request.method === 'POST' && isTelegramWebhookPath(new URL(request.url).pathname)) {
            try {
                if (isCodingUpdate(await request.clone().json())) {
                    return new Response('OK', { status: 200 });
                }
            } catch {
                // Let the application return its normal response for malformed updates.
            }
        }
        return app.fetch(request, env);
    },
};

export { CodingSessionDurableObject } from '@chatgpt-telegram-workers/core';
