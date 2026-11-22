import { MAX_DOCUMENT_CHARS, MAX_PDF_BYTES, MAX_PDF_PAGES } from './limits';
import type { DocumentPage, DocumentRecord, ParseOptions } from './types';
import { DocumentError } from './types';
import { isPdfBytes, PDF_MIME_TYPE } from './validate';

const MIN_TEXT_FOR_DIGITAL_PAGE = 20;

/**
 * Extracts text page-by-page with PDF.js. The serverless unpdf build runs on
 * the request event loop, so limits are enforced before and during extraction.
 */
export async function parsePdf(
    bytes: Uint8Array,
    fileName: string,
    options: ParseOptions = {},
): Promise<DocumentRecord> {
    if (!isPdfBytes(bytes)) {
        throw new DocumentError('unsupported', 'File is not a valid PDF');
    }
    if (bytes.byteLength > MAX_PDF_BYTES) {
        throw new DocumentError('too-large', `PDF exceeds the ${MAX_PDF_BYTES} byte limit`);
    }

    const maxPages = options.maxPages ?? MAX_PDF_PAGES;
    const maxChars = options.maxChars ?? MAX_DOCUMENT_CHARS;
    const { extractText, getDocumentProxy, inspectPages } = await import('unpdf');

    let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
    try {
        pdf = await getDocumentProxy(bytes, {
            isOffscreenCanvasSupported: false,
            isImageDecoderSupported: false,
        });

        if (pdf.numPages > maxPages) {
            throw new DocumentError('too-large', `PDF has ${pdf.numPages} pages; the limit is ${maxPages}`);
        }

        const inspected = await inspectPages(pdf);
        const extracted = await extractText(pdf, { mergePages: false });
        const texts = extracted.text;

        const pages: DocumentPage[] = [];
        let totalChars = 0;
        let truncated = false;

        for (let index = 0; index < texts.length; index++) {
            const info = inspected.pages[index];
            const rawText = texts[index] ?? '';
            const compactLength = rawText.replace(/\s+/g, '').length;
            const textLength = info?.textLength ?? compactLength;
            const imageCoverage = info?.imageCoverage ?? 0;
            const needsOcr = textLength < MIN_TEXT_FOR_DIGITAL_PAGE && imageCoverage > 0.1;

            let text = rawText.trim();
            if (totalChars + text.length > maxChars) {
                const remaining = maxChars - totalChars;
                text = remaining > 0 ? text.slice(0, remaining) : '';
                truncated = true;
            }
            totalChars += text.length;

            pages.push({
                pageNumber: index + 1,
                text,
                needsOcr,
                imageCoverage,
            });
        }

        if (pages.length === 0) {
            throw new DocumentError('empty', 'PDF contains no pages');
        }

        return {
            id: '',
            kind: 'pdf',
            fileName,
            mimeType: PDF_MIME_TYPE,
            sizeBytes: bytes.byteLength,
            pageCount: pages.length,
            charCount: totalChars,
            needsOcr: pages.some(page => page.needsOcr),
            truncated,
            pages,
        };
    } catch (error) {
        if (error instanceof DocumentError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/password|encrypted/i.test(message)) {
            throw new DocumentError('password', 'PDF is password-protected or encrypted');
        }
        throw new DocumentError('parse', `Failed to read PDF: ${message}`);
    } finally {
        if (pdf) {
            await pdf.cleanup().catch(() => {});
            await pdf.loadingTask.destroy().catch(() => {});
        }
    }
}
