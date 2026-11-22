import { fetchText, HttpStatusError, RedirectError, UnsupportedContentTypeError, WebTimeoutError } from './http';
import { UnsafeUrlError } from './url';

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body, {
        status,
        headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    });
}

describe('safe fetchText', () => {
    it('fetches text and reports the final URL', async () => {
        const fetchImpl = vi.fn(async () => htmlResponse('<html>ok</html>')) as unknown as typeof fetch;

        const result = await fetchText('https://example.com/', { fetchImpl });

        expect(result.text).toContain('ok');
        expect(result.finalUrl).toBe('https://example.com/');
        expect(result.contentType).toContain('text/html');
        expect(result.truncated).toBe(false);
    });

    it('follows redirects manually and validates the final URL', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
            .mockResolvedValueOnce(htmlResponse('redirected')) as unknown as typeof fetch;

        const result = await fetchText('https://example.com/start', { fetchImpl });

        expect(result.text).toBe('redirected');
        expect(result.finalUrl).toBe('https://example.com/next');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('blocks redirects to private addresses', async () => {
        const fetchImpl = vi.fn(
            async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
        ) as unknown as typeof fetch;

        await expect(fetchText('https://example.com/', { fetchImpl })).rejects.toBeInstanceOf(UnsafeUrlError);
    });

    it('limits redirects', async () => {
        const fetchImpl = vi.fn(
            async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
        ) as unknown as typeof fetch;

        await expect(fetchText('https://example.com/', { fetchImpl, maxRedirects: 1 })).rejects.toBeInstanceOf(
            RedirectError,
        );
    });

    it('rejects non-OK responses and unsupported content types', async () => {
        const errorFetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
        await expect(fetchText('https://example.com/', { fetchImpl: errorFetch })).rejects.toBeInstanceOf(
            HttpStatusError,
        );

        const pdfFetch = vi.fn(
            async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }),
        ) as unknown as typeof fetch;
        await expect(fetchText('https://example.com/file.pdf', { fetchImpl: pdfFetch })).rejects.toBeInstanceOf(
            UnsupportedContentTypeError,
        );
    });

    it('caps the response body size', async () => {
        const fetchImpl = vi.fn(
            async () => new Response('x'.repeat(100), { status: 200, headers: { 'content-type': 'text/plain' } }),
        ) as unknown as typeof fetch;

        const result = await fetchText('https://example.com/', { fetchImpl, maxBytes: 10 });

        expect(result.text).toHaveLength(10);
        expect(result.truncated).toBe(true);
    });

    it('times out slow requests', async () => {
        const fetchImpl = vi.fn((_input: string | URL, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            });
        }) as unknown as typeof fetch;

        await expect(fetchText('https://example.com/', { fetchImpl, timeoutMs: 10 })).rejects.toBeInstanceOf(
            WebTimeoutError,
        );
    });

    it('times out while reading a slow response body', async () => {
        const stream = new ReadableStream({
            start() {
                // Intentionally never enqueue or close.
            },
        });
        const fetchImpl = vi.fn(
            async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }),
        ) as unknown as typeof fetch;

        await expect(fetchText('https://example.com/', { fetchImpl, timeoutMs: 10 })).rejects.toBeInstanceOf(
            WebTimeoutError,
        );
    });

    it('propagates caller cancellation', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn((_input: string | URL, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            });
        }) as unknown as typeof fetch;

        const promise = fetchText('https://example.com/', { fetchImpl, signal: controller.signal });
        setTimeout(() => controller.abort(), 5);

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });
});
