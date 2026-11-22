export type DocumentKind = 'pdf' | 'docx';

export type DocumentErrorCode = 'unsupported' | 'too-large' | 'password' | 'empty' | 'parse';

export class DocumentError extends Error {
    readonly name = 'DocumentError';

    constructor(
        public readonly code: DocumentErrorCode,
        message: string,
    ) {
        super(message);
    }
}

export interface DocumentPage {
    /** 1-based page number. DOCX uses stable chunk numbers instead of physical pages. */
    pageNumber: number;
    text: string;
    /** True when the page looks like an image without a usable text layer. */
    needsOcr?: boolean;
    /** PDF image coverage (0-1), when available. */
    imageCoverage?: number;
    /** Heading path for DOCX chunks. */
    headingPath?: string[];
}

export interface DocumentRecord {
    id: string;
    kind: DocumentKind;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    pageCount: number;
    charCount: number;
    needsOcr: boolean;
    truncated: boolean;
    pages: DocumentPage[];
}

export interface ParseOptions {
    maxPages?: number;
    maxChars?: number;
}
