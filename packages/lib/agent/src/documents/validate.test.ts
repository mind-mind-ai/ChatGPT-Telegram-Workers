import { detectDocumentKind, detectImageMimeType, isPdfBytes, isZipBytes } from './validate';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const PDF = new TextEncoder().encode('%PDF-1.7');
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

describe('document and image validation', () => {
    it('detects PDF and ZIP magic bytes', () => {
        expect(isPdfBytes(PDF)).toBe(true);
        expect(isPdfBytes(PNG)).toBe(false);
        expect(isZipBytes(ZIP)).toBe(true);
        expect(isZipBytes(PDF)).toBe(false);
    });

    it('detects accepted vision image formats', () => {
        expect(detectImageMimeType(PNG)).toBe('image/png');
        expect(detectImageMimeType(JPEG)).toBe('image/jpeg');
        expect(detectImageMimeType(WEBP)).toBe('image/webp');
        expect(detectImageMimeType(new Uint8Array([1, 2, 3]))).toBeNull();
    });

    it('detects document kinds by content and name', () => {
        expect(detectDocumentKind(PDF, 'application/pdf', 'x.pdf')).toBe('pdf');
        expect(
            detectDocumentKind(
                ZIP,
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'x.docx',
            ),
        ).toBe('docx');
        expect(detectDocumentKind(ZIP, 'application/zip', 'x.docx')).toBe('docx');
        expect(detectDocumentKind(PNG, 'image/png', 'x.png')).toBeNull();
    });
});
