import { createAbortError, raceWithSignal } from '../errors';
import { assertSafeHttpUrl, UnsafeUrlError } from './url';

export const DEFAULT_WEB_TIMEOUT_MS = 15_000;
export const DEFAULT_WEB_MAX_BYTES = 1_000_000;
export const DEFAULT_WEB_MAX_REDIRECTS = 3;
export const DEFAULT_WEB_USER_AGENT =
    'ChatGPT-Telegram-Workers/1.0 (+https://github.com/mind-mind-ai/ChatGPT-Telegram-Workers)';

export const DEFAULT_ALLOWED_CONTENT_TYPES = [
    'text/html',
    'application/xhtml+xml',
    'text/plain',
    'application/json',
    'application/xml',
    'text/xml',
];

export class WebFetchError extends Error {
    readonly name: string = 'WebFetchError';
}

export class WebTimeoutError extends WebFetchError {
    readonly name = 'WebTimeoutError';
}

export class UnsupportedContentTypeError extends WebFetchError {
    readonly name = 'UnsupportedContentTypeError';
}

export class HttpStatusError extends WebFetchError {
    readonly name = 'HttpStatusError';

    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

export class RedirectError extends WebFetchError {
    readonly name = 'RedirectError';
}

export interface FetchTextOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    headers?: Record<string, string>;
    allowedContentTypes?: readonly string[];
    userAgent?: string;
}

export interface FetchTextResult {
    text: string;
    finalUrl: string;
    contentType: string;
    status: number;
    truncated: boolean;
}

interface FetchScope {
    signal: AbortSignal;
    timedOut: () => boolean;
    clear: () => void;
}

function createFetchScope(parent: AbortSignal | undefined, timeoutMs: number): FetchScope {
    const controller = new AbortController();
    let timedOut = false;

    const abortFromParent = () => controller.abort(parent?.reason);
    if (parent) {
        if (parent.aborted) {
            controller.abort(parent.reason);
        } else {
            parent.addEventListener('abort', abortFromParent, { once: true });
        }
    }

    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  controller.abort(new WebTimeoutError(`Web request timed out after ${timeoutMs} ms`));
              }, timeoutMs)
            : undefined;

    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        clear: () => {
            if (timer) {
                clearTimeout(timer);
            }
            parent?.removeEventListener('abort', abortFromParent);
        },
    };
}

export async function readResponseText(
    response: Response,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
    if (!response.body) {
        const buffer = signal ? await raceWithSignal(response.arrayBuffer(), signal) : await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const truncated = bytes.byteLength > maxBytes;
        return {
            text: new TextDecoder('utf-8', { fatal: false }).decode(truncated ? bytes.subarray(0, maxBytes) : bytes),
            truncated,
        };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    try {
        while (true) {
            const { done, value } = signal ? await raceWithSignal(reader.read(), signal) : await reader.read();
            if (done) {
                break;
            }
            if (!value) {
                continue;
            }
            if (total + value.byteLength > maxBytes) {
                const remaining = maxBytes - total;
                if (remaining > 0) {
                    chunks.push(value.subarray(0, remaining));
                    total += remaining;
                }
                truncated = true;
                await reader.cancel().catch(() => {});
                break;
            }
            chunks.push(value);
            total += value.byteLength;
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally {
        reader.releaseLock?.();
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return {
        text: new TextDecoder('utf-8', { fatal: false }).decode(merged),
        truncated,
    };
}

function isRedirect(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function cancelBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // The body may already be consumed or locked; nothing to do.
    }
}

export async function fetchText(rawUrl: string | URL, options: FetchTextOptions = {}): Promise<FetchTextResult> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
    const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_WEB_MAX_BYTES);
    const maxRedirects = Math.max(0, options.maxRedirects ?? DEFAULT_WEB_MAX_REDIRECTS);
    const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
    const scope = createFetchScope(options.signal, timeoutMs);

    let current = assertSafeHttpUrl(rawUrl);

    try {
        for (let redirects = 0; redirects <= maxRedirects; redirects++) {
            const headers: Record<string, string> = {
                accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,application/xml;q=0.7,text/xml;q=0.7',
                'user-agent': options.userAgent ?? DEFAULT_WEB_USER_AGENT,
                ...options.headers,
            };

            const response = await raceWithSignal(
                fetchImpl(current, {
                    method: 'GET',
                    headers,
                    redirect: 'manual',
                    signal: scope.signal,
                }),
                scope.signal,
            );

            if (isRedirect(response.status)) {
                if (redirects === maxRedirects) {
                    await cancelBody(response);
                    throw new RedirectError(`Too many redirects (limit ${maxRedirects})`);
                }
                const location = response.headers.get('location');
                await cancelBody(response);
                if (!location) {
                    throw new RedirectError(`Redirect ${response.status} without a Location header`);
                }
                let next: URL;
                try {
                    next = new URL(location, current);
                } catch {
                    throw new RedirectError('Invalid redirect location');
                }
                current = assertSafeHttpUrl(next);
                continue;
            }

            if (!response.ok) {
                await cancelBody(response);
                throw new HttpStatusError(response.status, `HTTP ${response.status} ${response.statusText}`.trim());
            }

            const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
            if (
                allowedContentTypes.length > 0 &&
                contentType &&
                !allowedContentTypes.some(type => contentType.includes(type))
            ) {
                await cancelBody(response);
                throw new UnsupportedContentTypeError(`Unsupported content type: ${contentType}`);
            }

            const body = await readResponseText(response, maxBytes, scope.signal);
            return {
                text: body.text,
                finalUrl: current.toString(),
                contentType,
                status: response.status,
                truncated: body.truncated,
            };
        }

        throw new RedirectError(`Too many redirects (limit ${maxRedirects})`);
    } catch (error) {
        if (scope.timedOut()) {
            throw new WebTimeoutError(`Web request timed out after ${timeoutMs} ms`);
        }
        if (options.signal?.aborted) {
            throw createAbortError('Web request aborted', options.signal.reason);
        }
        throw error;
    } finally {
        scope.clear();
    }
}

export function formatWebError(error: unknown): string {
    if (error instanceof UnsafeUrlError) {
        return `blocked URL: ${error.message}`;
    }
    if (error instanceof HttpStatusError) {
        if (error.status === 429) {
            return 'rate limit reached; try again later';
        }
        return error.message;
    }
    if (error instanceof WebFetchError) {
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
