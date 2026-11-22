import { strFromU8, unzipSync } from 'fflate';
import {
    MAX_DOCUMENT_CHARS,
    MAX_DOCX_BYTES,
    MAX_DOCX_ENTRIES,
    MAX_DOCX_ENTRY_BYTES,
    MAX_DOCX_UNCOMPRESSED_BYTES,
} from './limits';
import type { DocumentPage, DocumentRecord, ParseOptions } from './types';
import { DocumentError } from './types';
import { DOCX_MIME_TYPE, isZipBytes } from './validate';

const DOCX_CHUNK_CHARS = 3_000;

interface TextBlock {
    text: string;
    headingLevel: number;
    headingPath: string[];
}

const XML_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

function decodeXmlEntities(value: string): string {
    return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
            const code = Number.parseInt(entity.slice(2), 16);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        if (entity.startsWith('#')) {
            const code = Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        return XML_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

function paragraphText(paragraphXml: string): string {
    const tokens = paragraphXml.matchAll(
        /<(?:w:)?t\b[^>]*>([\s\S]*?)<\/(?:w:)?t>|<(?:w:)?tab\b[^>]*\/>|<(?:w:)?br\b[^>]*\/>/g,
    );
    let text = '';
    for (const token of tokens) {
        if (token[1] !== undefined) {
            text += decodeXmlEntities(token[1]);
        } else if (/<(?:w:)?tab\b/i.test(token[0])) {
            text += '\t';
        } else {
            text += '\n';
        }
    }
    return text;
}

function headingLevelFromId(styleId: string): number {
    const match = /heading\s*(\d+)/i.exec(styleId) ?? /(?:^|\D)(\d+)$/.exec(styleId);
    return match ? Math.min(6, Number(match[1])) : 0;
}

function parseStyleHeadings(stylesXml: string | undefined): Map<string, number> {
    const headings = new Map<string, number>();
    if (!stylesXml) {
        return headings;
    }
    const styles = stylesXml.matchAll(
        /<(?:w:)?style\b[^>]*\b(?:w:)?styleId="([^"]+)"[^>]*>([\s\S]*?)<\/(?:w:)?style>/g,
    );
    for (const style of styles) {
        const styleId = style[1];
        const body = style[2];
        const name = /<(?:w:)?name\b[^>]*\b(?:w:)?val="([^"]+)"/.exec(body)?.[1] ?? '';
        const outline = /<(?:w:)?outlineLvl\b[^>]*\b(?:w:)?val="(\d+)"/.exec(body)?.[1];
        let level = outline !== undefined ? Math.min(6, Number(outline) + 1) : 0;
        if (level === 0) {
            level = headingLevelFromId(name) || headingLevelFromId(styleId);
        }
        if (level > 0) {
            headings.set(styleId, level);
        }
    }
    return headings;
}

function parseParagraphs(documentXml: string, styleHeadings: Map<string, number>): TextBlock[] {
    const blocks: TextBlock[] = [];
    const headingStack: string[] = [];
    const paragraphs = documentXml.matchAll(/<(?:w:)?p\b[^>]*>([\s\S]*?)<\/(?:w:)?p>/g);

    for (const paragraph of paragraphs) {
        const body = paragraph[1];
        const text = paragraphText(body).trim();
        if (!text) {
            continue;
        }

        const styleId = /<(?:w:)?pStyle\b[^>]*\b(?:w:)?val="([^"]+)"/.exec(body)?.[1];
        const outline = /<(?:w:)?outlineLvl\b[^>]*\b(?:w:)?val="(\d+)"/.exec(body)?.[1];
        let headingLevel = styleId ? (styleHeadings.get(styleId) ?? headingLevelFromId(styleId)) : 0;
        if (headingLevel === 0 && outline !== undefined) {
            headingLevel = Math.min(6, Number(outline) + 1);
        }
        headingLevel = Math.min(6, headingLevel);
        const isList = /<(?:w:)?numPr\b/.test(body);

        if (headingLevel > 0) {
            headingStack.length = headingLevel - 1;
            headingStack[headingLevel - 1] = text;
            blocks.push({
                text: `${'#'.repeat(headingLevel)} ${text}`,
                headingLevel,
                headingPath: [...headingStack],
            });
        } else {
            blocks.push({
                text: `${isList ? '- ' : ''}${text}`,
                headingLevel: 0,
                headingPath: [...headingStack],
            });
        }
    }
    return blocks;
}

function blocksToPages(blocks: TextBlock[], maxChars: number): { pages: DocumentPage[]; truncated: boolean } {
    const pages: DocumentPage[] = [];
    let currentText = '';
    let currentHeading: string[] = [];
    let totalChars = 0;
    let truncated = false;

    const flush = (): void => {
        if (!currentText) {
            return;
        }
        pages.push({
            pageNumber: pages.length + 1,
            text: currentText,
            headingPath: currentHeading,
        });
        currentText = '';
    };

    for (const block of blocks) {
        if (totalChars >= maxChars) {
            truncated = true;
            break;
        }
        let text = block.text;
        if (totalChars + text.length > maxChars) {
            text = text.slice(0, maxChars - totalChars);
            truncated = true;
        }
        const addition = currentText ? `\n${text}` : text;
        if (currentText && currentText.length + addition.length > DOCX_CHUNK_CHARS) {
            flush();
            currentHeading = block.headingPath;
            currentText = text;
        } else {
            if (!currentText) {
                currentHeading = block.headingPath;
            }
            currentText += addition;
        }
        totalChars += text.length;
    }
    flush();

    if (pages.length === 0) {
        pages.push({ pageNumber: 1, text: '', headingPath: [], needsOcr: true });
    }
    return { pages, truncated };
}

function readDocxFiles(bytes: Uint8Array): Record<string, Uint8Array> {
    if (!isZipBytes(bytes)) {
        throw new DocumentError('unsupported', 'File is not a valid DOCX archive');
    }
    if (bytes.byteLength > MAX_DOCX_BYTES) {
        throw new DocumentError('too-large', `DOCX exceeds the ${MAX_DOCX_BYTES} byte limit`);
    }

    let entries = 0;
    let uncompressedBytes = 0;
    try {
        return unzipSync(bytes, {
            filter: file => {
                entries += 1;
                if (entries > MAX_DOCX_ENTRIES) {
                    throw new DocumentError('too-large', `DOCX has more than ${MAX_DOCX_ENTRIES} entries`);
                }
                if (file.originalSize > MAX_DOCX_ENTRY_BYTES) {
                    throw new DocumentError('too-large', 'DOCX contains an oversized entry');
                }
                uncompressedBytes += file.originalSize;
                if (uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
                    throw new DocumentError('too-large', 'DOCX uncompressed size exceeds the limit');
                }
                return (
                    file.name === '[Content_Types].xml' ||
                    file.name === 'word/document.xml' ||
                    file.name === 'word/styles.xml' ||
                    file.name === 'docProps/core.xml'
                );
            },
        });
    } catch (error) {
        if (error instanceof DocumentError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new DocumentError('parse', `Failed to read DOCX archive: ${message}`);
    }
}

/** Extracts visible paragraph text and heading structure from a DOCX file. */
export async function parseDocx(
    bytes: Uint8Array,
    fileName: string,
    options: ParseOptions = {},
): Promise<DocumentRecord> {
    const maxChars = options.maxChars ?? MAX_DOCUMENT_CHARS;
    const files = readDocxFiles(bytes);
    const documentXml = files['word/document.xml'];
    if (!documentXml) {
        throw new DocumentError('parse', 'DOCX is missing word/document.xml');
    }

    const documentText = strFromU8(documentXml);
    const stylesXml = files['word/styles.xml'] ? strFromU8(files['word/styles.xml']) : undefined;
    const blocks = parseParagraphs(documentText, parseStyleHeadings(stylesXml));
    const { pages, truncated } = blocksToPages(blocks, maxChars);
    const charCount = pages.reduce((sum, page) => sum + page.text.length, 0);

    return {
        id: '',
        kind: 'docx',
        fileName,
        mimeType: DOCX_MIME_TYPE,
        sizeBytes: bytes.byteLength,
        pageCount: pages.length,
        charCount,
        needsOcr: pages.every(page => !page.text),
        truncated,
        pages,
    };
}
