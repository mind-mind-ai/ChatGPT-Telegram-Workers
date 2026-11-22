import { raceWithSignal } from '../errors';
import { GitHubError } from './errors';

export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
export const DEFAULT_GITHUB_TIMEOUT_MS = 15_000;
export const DEFAULT_GITHUB_MAX_JSON_BYTES = 1_000_000;
export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_USER_AGENT = 'ChatGPT-Telegram-Workers/1.0';

export interface GitHubRequestOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: 'follow' | 'manual' | 'error';
}

export async function fetchGitHubResponse(url: string, options: GitHubRequestOptions = {}): Promise<Response> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    let timedOut = false;

    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal) {
        if (options.signal.aborted) {
            throw new GitHubError('aborted', 'GitHub request aborted');
        }
        options.signal.addEventListener('abort', abortFromParent, { once: true });
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;
    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  controller.abort(new GitHubError('timeout', 'GitHub request timed out'));
              }, timeoutMs)
            : undefined;

    try {
        return await raceWithSignal(
            Promise.resolve(
                fetchImpl(url, {
                    method: options.method ?? 'GET',
                    headers: {
                        accept: 'application/vnd.github+json',
                        'x-github-api-version': GITHUB_API_VERSION,
                        'user-agent': GITHUB_USER_AGENT,
                        ...options.headers,
                    },
                    ...(options.body === undefined ? {} : { body: options.body }),
                    redirect: options.redirect ?? 'manual',
                    signal: controller.signal,
                }),
            ),
            controller.signal,
        );
    } catch (error) {
        if (timedOut) {
            throw new GitHubError('timeout', 'GitHub request timed out', { cause: error });
        }
        if (options.signal?.aborted) {
            throw new GitHubError('aborted', 'GitHub request aborted', { cause: error });
        }
        throw new GitHubError('api', 'GitHub request failed', { cause: error });
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
        options.signal?.removeEventListener('abort', abortFromParent);
    }
}

async function cancelBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // The body may already be consumed or locked.
    }
}

export async function readGitHubResponseBytes(
    response: Response,
    maxBytes: number,
    signal?: AbortSignal,
    timeoutMs = 0,
): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
        await cancelBody(response);
        throw new GitHubError('limit', 'GitHub response exceeds the size limit');
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal) {
        if (signal.aborted) {
            throw new GitHubError('aborted', 'GitHub response read aborted');
        }
        signal.addEventListener('abort', abortFromParent, { once: true });
    }
    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  controller.abort(new GitHubError('timeout', 'GitHub response timed out'));
              }, timeoutMs)
            : undefined;

    try {
        if (!response.body) {
            const bytes = new Uint8Array(await raceWithSignal(response.arrayBuffer(), controller.signal));
            if (bytes.byteLength > maxBytes) {
                throw new GitHubError('limit', 'GitHub response exceeds the size limit');
            }
            return bytes;
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await raceWithSignal(reader.read(), controller.signal);
                if (done) {
                    break;
                }
                if (!value) {
                    continue;
                }
                if (total + value.byteLength > maxBytes) {
                    await reader.cancel().catch(() => {});
                    throw new GitHubError('limit', 'GitHub response exceeds the size limit');
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

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    } catch (error) {
        if (timedOut) {
            throw new GitHubError('timeout', 'GitHub response timed out', { cause: error });
        }
        if (signal?.aborted) {
            throw new GitHubError('aborted', 'GitHub response read aborted', { cause: error });
        }
        throw error;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
        signal?.removeEventListener('abort', abortFromParent);
    }
}

export async function readGitHubResponseJson<T>(
    response: Response,
    maxBytes = DEFAULT_GITHUB_MAX_JSON_BYTES,
    signal?: AbortSignal,
    timeoutMs = 0,
): Promise<T> {
    const bytes = await readGitHubResponseBytes(response, maxBytes, signal, timeoutMs);
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes)) as T;
    } catch (error) {
        throw new GitHubError('api', 'GitHub returned invalid JSON', { cause: error });
    }
}

function retryAfterSeconds(response: Response): number | undefined {
    const retryAfter = Number(response.headers.get('retry-after') ?? '');
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.ceil(retryAfter);
    }
    const reset = Number(response.headers.get('x-ratelimit-reset') ?? '');
    if (Number.isFinite(reset) && reset > 0) {
        return Math.max(1, Math.ceil(reset - Date.now() / 1000));
    }
    return undefined;
}

export function mapGitHubHttpError(response: Response): GitHubError {
    const status = response.status;
    const retry = retryAfterSeconds(response);
    if (status === 401) {
        return new GitHubError('auth', 'GitHub authentication failed', { status });
    }
    if (status === 404) {
        return new GitHubError('not-found', 'Repository not found or not accessible', { status });
    }
    if (status === 429 || (status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
        return new GitHubError('rate-limit', 'GitHub rate limit reached', {
            status,
            ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
        });
    }
    if (status === 403) {
        return new GitHubError('unauthorized', 'GitHub denied access to this resource', {
            status,
            ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
        });
    }
    if (status >= 500) {
        return new GitHubError('api', `GitHub service error (${status})`, { status });
    }
    return new GitHubError('api', `GitHub request failed (${status})`, { status });
}

export function assertAllowedArchiveUrl(location: string, apiBaseUrl: string): string {
    let url: URL;
    try {
        url = new URL(location);
    } catch (error) {
        throw new GitHubError('api', 'GitHub archive redirect was invalid', { cause: error });
    }
    if (url.protocol !== 'https:') {
        throw new GitHubError('api', 'GitHub archive redirect must use HTTPS');
    }
    const apiHost = new URL(apiBaseUrl).hostname;
    const allowed =
        url.hostname === apiHost ||
        url.hostname === 'github.com' ||
        url.hostname === 'codeload.github.com' ||
        url.hostname.endsWith('.github.com');
    if (!allowed) {
        throw new GitHubError('api', 'GitHub archive redirect was blocked');
    }
    return url.toString();
}
