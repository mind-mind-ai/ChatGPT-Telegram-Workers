import { parsePdf } from './pdf';
import { base64ToBytes, SAMPLE_PDF_BASE64, SCANNED_PDF_BASE64 } from './fixtures';

describe('parsePdf', () => {
    it('extracts text page by page with 1-based page numbers', async () => {
        const document = await parsePdf(base64ToBytes(SAMPLE_PDF_BASE64), 'sample.pdf');

        expect(document.kind).toBe('pdf');
        expect(document.pageCount).toBe(2);
        expect(document.pages[0].pageNumber).toBe(1);
        expect(document.pages[0].text).toContain('Page one');
        expect(document.pages[1].pageNumber).toBe(2);
        expect(document.pages[1].text).toContain('Page two');
        expect(document.needsOcr).toBe(false);
        expect(document.truncated).toBe(false);
    });

    it('detects an image-only scanned PDF and reports OCR need', async () => {
        const document = await parsePdf(base64ToBytes(SCANNED_PDF_BASE64), 'scanned.pdf');

        expect(document.pageCount).toBe(1);
        expect(document.pages[0].needsOcr).toBe(true);
        expect(document.needsOcr).toBe(true);
        expect(document.pages[0].text).toBe('');
    });

    it('enforces the page limit', async () => {
        await expect(parsePdf(base64ToBytes(SAMPLE_PDF_BASE64), 'sample.pdf', { maxPages: 1 })).rejects.toMatchObject({
            code: 'too-large',
        });
    });

    it('rejects content that is not a PDF', async () => {
        await expect(parsePdf(new Uint8Array([1, 2, 3]), 'fake.pdf')).rejects.toMatchObject({
            code: 'unsupported',
        });
    });
});
