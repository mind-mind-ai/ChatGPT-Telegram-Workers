import type { DocumentKind } from './types';

export const PDF_MIME_TYPE = 'application/pdf';
export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function isPdfBytes(bytes: Uint8Array): boolean {
    return (
        bytes.length >= 5 &&
        bytes[0] === 0x25 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x44 &&
        bytes[3] === 0x46 &&
        bytes[4] === 0x2d
    );
}

export function isZipBytes(bytes: Uint8Array): boolean {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Returns a safe image MIME type for the formats accepted by vision providers. */
export function detectImageMimeType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return 'image/png';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}

export function detectDocumentKind(bytes: Uint8Array, mimeType?: string, fileName?: string): DocumentKind | null {
    if (isPdfBytes(bytes)) {
        return 'pdf';
    }
    if (isZipBytes(bytes)) {
        const name = (fileName ?? '').toLowerCase();
        if (mimeType === DOCX_MIME_TYPE || name.endsWith('.docx')) {
            return 'docx';
        }
        // A ZIP without a DOCX marker is still worth trying: the parser requires
        // word/document.xml and rejects ordinary ZIP files.
        return 'docx';
    }
    return null;
}
