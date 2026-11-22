import { raceWithAbort } from './abort';

export interface LimitedBytes {
    bytes: Uint8Array;
    truncated: boolean;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

/**
 * Reads a stream while retaining at most `maxBytes`. Bytes beyond the limit
 * are drained instead of left unread, so the child process is not blocked.
 */
export async function readStreamLimited(
    stream: ReadableStream<Uint8Array> | null,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<LimitedBytes> {
    if (!stream) {
        return { bytes: new Uint8Array(0), truncated: false };
    }
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    try {
        while (true) {
            const result = await (signal ? raceWithAbort(reader.read(), signal) : reader.read());
            if (result.done) {
                break;
            }
            const value = result.value;
            if (!value) {
                continue;
            }
            if (total < maxBytes) {
                const take = Math.min(value.byteLength, maxBytes - total);
                if (take > 0) {
                    chunks.push(value.subarray(0, take));
                    total += take;
                }
                if (take < value.byteLength) {
                    truncated = true;
                }
            } else {
                truncated = true;
            }
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock?.();
    }

    return { bytes: concat(chunks, total), truncated };
}

export async function readResponseLimited(
    response: Response,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<LimitedBytes> {
    if (!response.body) {
        const buffer = signal ? await raceWithAbort(response.arrayBuffer(), signal) : await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const truncated = bytes.byteLength > maxBytes;
        return {
            bytes: truncated ? bytes.subarray(0, maxBytes) : bytes,
            truncated,
        };
    }
    return readStreamLimited(response.body, maxBytes, signal);
}
