import type * as Telegram from 'telegram-bot-api-types';
import { ENV, cloneDefaultConfig } from '@chatgpt-telegram-workers/config';
import { DocumentStore, MAX_IMAGE_BYTES } from '@chatgpt-telegram-workers/agent';
import {
    buildAttachmentUserMessage,
    detectAttachments,
    downloadTelegramFile,
    prepareAttachment,
    type DownloadOptions,
} from './attachments';

const SAMPLE_PDF_BASE64 =
    'JVBERi0xLjcKJYGBgYEKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAxMjAKPj4Kc3RyZWFtCnicHYoxCkJBDAX7nCK1IGZj9mU/iKCyi4WNkAuIfOWLFop4flcZmGKYJ22DhH+8rrTYj/fP+J7Op7nLUKyIl4GTclxIjeNA6b8m1i4Ix4NWWZDgyCpoqMjLjYoVZOw6TSWLmUHFHc21N9O65rhRzKgGHekLwQUc7AplbmRzdHJlYW0KZW5kb2JqCgo4IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggMTIxCj4+CnN0cmVhbQp4nD2KQQoCQQwE73lFzoI4k0k6K8iCwiwevAj5gMgqih5WxPc7KkhDHaprok1Q4s8eZ1psx9trfF6Oh/nSVdCJoeMsHCcS5dhR/qaZpQGJ404rS8hwmCRXdwxlLckKDAUDKrT5f/Fzru1tlNpzXClmVIP29AapZB6JCmVuZHN0cmVhbQplbmRvYmoKCjkgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL09ialN0bQovTiA2Ci9GaXJzdCAzMgovTGVuZ3RoIDM4Mwo+PgpzdHJlYW0KeJzVUsFKxDAQvecr5qgHyTRtk1SWhXW3VRBRVFAUD7UNS0USabOif+9MuyoexIN4kDJNZubN5E3yEkBQkCOkYDPIIE8t5KAVggFTFDCbCXn5+uRAntVrNwh53LUD3BIG4Zww/L8Tchk2PoIS87n4rFjWsX4MazGVQsLgd8RZH9pN43qYVWVVIRpE1BmZRlQrWpdkBZkin3LK0p7MZFujmEkR0wXlqsm0mWo4P2LzbX1JK2E1Y1YTNrOT/3Eun1VOPdRPfIq5kCehXdXRwc5qX6HSSaJUkmeYmptduo7e1TH83+FG/l3w30745Z2r4KOQF5v7OLocTIQ8qAfHGZBH7vHZxa6phSx9E9rOr0FedX7hh+498LUjC4Zl0zuqn3Qjz90QNn1DQmLc2Jk3H833DBaWJje2IB1vpSavT+8fXDNC2S1f4uFF5KmmAMdOXNvVB+GFVI300V0C3QOreuF9iKz2UeE+Ehv29Fb1v6dcmExpq3Jt/5iy/aT8Bt8X9+wKZW5kc3RyZWFtCmVuZG9iagoKMTAgMCBvYmoKPDwKL1NpemUgMTEKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL1hSZWYKL0xlbmd0aCA0NwovVyBbIDEgMiAyIF0KL0luZGV4IFsgMCAxMSBdCj4+CnN0cmVhbQp4nCXJsRUAEBBEwb93BDLl6kNlKjr2SSYZoCoYYGTCpGli/ujigLQfueACg7cERAplbmRzdHJlYW0KZW5kb2JqCgpzdGFydHhyZWYKODg4CiUlRU9G';

function bytesFromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function telegramMessage(overrides: Partial<Telegram.Message>): Telegram.Message {
    return {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 10, type: 'private' },
        from: { id: 20, is_bot: false, first_name: 'User' },
        ...overrides,
    };
}

function fakeApi(filePath: string, fileSize?: number): NonNullable<DownloadOptions['api']> {
    return {
        getFileWithReturns: async () => ({
            result: { file_path: filePath, ...(fileSize !== undefined ? { file_size: fileSize } : {}) },
        }),
    } as unknown as NonNullable<DownloadOptions['api']>;
}

function fakeFetch(bytes: Uint8Array, status = 200): typeof fetch {
    return (async () =>
        new Response(bytes, {
            status,
            headers: { 'content-length': `${bytes.byteLength}` },
        })) as unknown as typeof fetch;
}

beforeEach(() => {
    ENV.CONFIG = cloneDefaultConfig();
});

describe('detectAttachments', () => {
    it('detects a PDF document without requiring a caption', () => {
        const message = telegramMessage({
            document: {
                file_id: 'pdf-1',
                file_unique_id: 'u1',
                file_name: 'report.pdf',
                mime_type: 'application/pdf',
                file_size: 100,
            },
        });
        expect(detectAttachments(message)).toEqual([
            {
                kind: 'pdf',
                fileId: 'pdf-1',
                fileName: 'report.pdf',
                mimeType: 'application/pdf',
                fileSize: 100,
                fromReply: false,
            },
        ]);
    });

    it('marks documents without usable MIME metadata for magic-byte detection', () => {
        const message = telegramMessage({
            document: { file_id: 'unknown-1', file_unique_id: 'u0' },
        });
        expect(detectAttachments(message)).toMatchObject([{ kind: 'unknown', fileName: 'document' }]);
    });

    it('detects photos and reply-to documents', () => {
        const message = telegramMessage({
            photo: [{ file_id: 'photo-1', file_unique_id: 'p1', width: 10, height: 10, file_size: 4 }],
            reply_to_message: telegramMessage({
                document: {
                    file_id: 'doc-2',
                    file_unique_id: 'u2',
                    file_name: 'notes.docx',
                    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    file_size: 200,
                },
            }),
        });
        const attachments = detectAttachments(message);
        expect(attachments.map(item => item.kind)).toEqual(['image', 'docx']);
        expect(attachments[1].fromReply).toBe(true);
    });

    it('ignores attachments in bot reply-to messages', () => {
        const message = telegramMessage({
            reply_to_message: telegramMessage({
                from: { id: 99, is_bot: true, first_name: 'Bot' },
                document: { file_id: 'bot-doc', file_unique_id: 'b1', file_name: 'bot.pdf' },
            }),
        });
        expect(detectAttachments(message)).toEqual([]);
    });
});

describe('downloadTelegramFile', () => {
    it('downloads bytes and enforces the size limit', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const downloaded = await downloadTelegramFile('file-1', '123:token', {
            api: fakeApi('files/a.bin', bytes.length),
            fetchImpl: fakeFetch(bytes),
            maxBytes: 10,
        });
        expect([...downloaded]).toEqual([1, 2, 3, 4]);

        await expect(
            downloadTelegramFile('file-1', '123:token', {
                api: fakeApi('files/a.bin', bytes.length),
                fetchImpl: fakeFetch(bytes),
                maxBytes: 2,
            }),
        ).rejects.toMatchObject({ code: 'too-large' });
    });

    it('wraps Telegram getFile failures as attachment errors', async () => {
        const api = {
            getFileWithReturns: async () => {
                throw new Error('network down');
            },
        } as unknown as NonNullable<DownloadOptions['api']>;
        await expect(downloadTelegramFile('file-1', '123:token', { api, maxBytes: 10 })).rejects.toMatchObject({
            code: 'download',
        });
    });

    it('redacts the bot token from download errors', async () => {
        const token = '123:token';
        const api = {
            getFileWithReturns: async () => {
                throw new Error(`failed https://api.telegram.org/file/bot${token}/x`);
            },
        } as unknown as NonNullable<DownloadOptions['api']>;
        const error = await downloadTelegramFile('file-1', token, { api, maxBytes: 10 }).catch(e => e);
        expect(error.message).not.toContain(token);
        expect(error.message).toContain('[redacted]');

        const fetchError = await downloadTelegramFile('file-1', token, {
            api: fakeApi('files/a.bin'),
            fetchImpl: (async () => {
                throw new Error(`network https://api.telegram.org/file/bot${token}/x`);
            }) as unknown as typeof fetch,
            maxBytes: 10,
        }).catch(e => e);
        expect(fetchError.message).not.toContain(token);
        expect(fetchError.message).toContain('[redacted]');
    });

    it('rejects a response whose content-length exceeds the limit', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        await expect(
            downloadTelegramFile('file-1', '123:token', {
                api: fakeApi('files/a.bin'),
                fetchImpl: fakeFetch(bytes),
                maxBytes: 2,
            }),
        ).rejects.toMatchObject({ code: 'too-large' });
    });
});

describe('prepareAttachment', () => {
    it('parses a PDF and stores it in the request-scoped store', async () => {
        const pdf = bytesFromBase64(SAMPLE_PDF_BASE64);
        const store = new DocumentStore();
        const prepared = await prepareAttachment(
            { kind: 'pdf', fileId: 'pdf-1', fileName: 'report.pdf', mimeType: 'application/pdf', fromReply: false },
            '123:token',
            store,
            { api: fakeApi('files/report.pdf', pdf.length), fetchImpl: fakeFetch(pdf) },
        );

        expect(prepared.document?.pageCount).toBe(2);
        expect(prepared.document?.pages[0].text).toContain('Page one');
        expect(store.list()).toHaveLength(1);
    });

    it('detects a PDF without MIME metadata from its bytes', async () => {
        const pdf = bytesFromBase64(SAMPLE_PDF_BASE64);
        const store = new DocumentStore();
        const prepared = await prepareAttachment(
            { kind: 'unknown', fileId: 'pdf-2', fileName: 'upload', fromReply: false },
            '123:token',
            store,
            { api: fakeApi('files/upload', pdf.length), fetchImpl: fakeFetch(pdf) },
        );

        expect(prepared.input.kind).toBe('pdf');
        expect(prepared.document?.pageCount).toBe(2);
    });

    it('returns image bytes for the vision model', async () => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
        const store = new DocumentStore();
        const prepared = await prepareAttachment(
            { kind: 'image', fileId: 'img-1', fileName: 'photo.png', mimeType: 'image/png', fromReply: false },
            '123:token',
            store,
            { api: fakeApi('files/photo.png', png.length), fetchImpl: fakeFetch(png) },
        );

        expect(prepared.image).toMatchObject({ type: 'image', mimeType: 'image/png' });
        expect(prepared.document).toBeUndefined();
        expect(store.list()).toEqual([]);
    });

    it('rejects image bytes with an unsupported signature', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const store = new DocumentStore();
        await expect(
            prepareAttachment(
                { kind: 'image', fileId: 'bad-image', fileName: 'bad.bin', fromReply: false },
                '123:token',
                store,
                { api: fakeApi('files/bad.bin', bytes.length), fetchImpl: fakeFetch(bytes) },
            ),
        ).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('rejects unsupported types and oversized files before downloading', async () => {
        const store = new DocumentStore();
        await expect(
            prepareAttachment(
                { kind: 'unsupported', fileId: 'x', fileName: 'x.exe', fromReply: false },
                '123:token',
                store,
            ),
        ).rejects.toMatchObject({ code: 'unsupported' });

        await expect(
            prepareAttachment(
                {
                    kind: 'image',
                    fileId: 'x',
                    fileName: 'x.png',
                    fileSize: MAX_IMAGE_BYTES + 1,
                    fromReply: false,
                },
                '123:token',
                store,
            ),
        ).rejects.toMatchObject({ code: 'too-large' });
    });
});

describe('buildAttachmentUserMessage', () => {
    it('builds a text message with a document id and a default prompt', () => {
        const store = new DocumentStore();
        const document = store.add({
            kind: 'pdf',
            fileName: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 10,
            pageCount: 1,
            charCount: 10,
            needsOcr: true,
            truncated: false,
            pages: [{ pageNumber: 1, text: '', needsOcr: true }],
        });
        const message = buildAttachmentUserMessage(
            [{ input: { kind: 'pdf', fileId: 'f', fileName: 'report.pdf', fromReply: false }, document }],
            undefined,
        );
        expect(typeof message.content).toBe('string');
        expect(message.content).toContain('Summarize the attached document');
        expect(message.content).toContain('document_id: doc1');
        expect(message.content).toContain('OCR is not enabled');
    });

    it('includes image bytes as an image part and uses the caption when provided', () => {
        const image = { type: 'image' as const, image: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };
        const message = buildAttachmentUserMessage(
            [{ input: { kind: 'image', fileId: 'i', fileName: 'photo.png', fromReply: false }, image }],
            'What is in this image?',
        );
        expect(Array.isArray(message.content)).toBe(true);
        const parts = message.content as Array<{ type: string; text?: string; image?: Uint8Array }>;
        expect(parts[0]).toMatchObject({ type: 'text' });
        expect(parts[0].text).toContain('What is in this image?');
        expect(parts[1]).toMatchObject({ type: 'image', image: image.image });
    });
});
