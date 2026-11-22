import { ToolRegistry } from '../tools';
import { DocumentStore } from './store';
import { createDocumentTools } from './tools';
import { DOCUMENT_PERMISSION } from './limits';

function seed(): DocumentStore {
    const store = new DocumentStore();
    store.add({
        kind: 'pdf',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        pageCount: 3,
        charCount: 120,
        needsOcr: false,
        truncated: false,
        pages: [
            { pageNumber: 1, text: 'Alpha introduction and overview.' },
            { pageNumber: 2, text: 'Beta findings and the important number 42.' },
            { pageNumber: 3, text: 'Gamma conclusion and recommendations.' },
        ],
    });
    return store;
}

function call(name: string, args: Record<string, unknown>) {
    return { id: 'call-1', name, arguments: JSON.stringify(args) };
}

describe('document tools', () => {
    it('lists documents with metadata', async () => {
        const registry = new ToolRegistry();
        registry.registerAll(createDocumentTools(seed()));
        const result = await registry.execute(call('document_list', {}), {
            permissions: [DOCUMENT_PERMISSION],
        });
        expect(result.content).toContain('doc1: report.pdf');
        expect(result.content).toContain('3 pages');
        expect(result.content).toContain('UNTRUSTED');
    });

    it('returns an outline and page previews', async () => {
        const registry = new ToolRegistry();
        registry.registerAll(createDocumentTools(seed()));
        const result = await registry.execute(call('document_outline', { document_id: 'doc1' }), {
            permissions: [DOCUMENT_PERMISSION],
        });
        expect(result.content).toContain('Outline for report.pdf');
        expect(result.content).toContain('Page 1: Alpha');
        expect(result.content).toContain('Page 2: Beta');
    });

    it('reads a page range and keeps page numbers', async () => {
        const registry = new ToolRegistry();
        registry.registerAll(createDocumentTools(seed()));
        const result = await registry.execute(
            call('document_read', { document_id: 'doc1', page_start: 2, page_end: 2 }),
            { permissions: [DOCUMENT_PERMISSION] },
        );
        expect(result.content).toContain('--- Page 2 ---');
        expect(result.content).toContain('Beta findings');
        expect(result.content).not.toContain('Gamma conclusion');
    });

    it('searches case-insensitively and returns the matching page', async () => {
        const registry = new ToolRegistry();
        registry.registerAll(createDocumentTools(seed()));
        const result = await registry.execute(call('document_search', { document_id: 'doc1', query: 'IMPORTANT' }), {
            permissions: [DOCUMENT_PERMISSION],
        });
        expect(result.content).toContain('Page 2');
        expect(result.content).toContain('important number 42');
    });

    it('rejects unknown document ids', async () => {
        const registry = new ToolRegistry();
        registry.registerAll(createDocumentTools(seed()));
        const result = await registry.execute(call('document_read', { document_id: 'doc9' }), {
            permissions: [DOCUMENT_PERMISSION],
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain('Unknown document_id');
    });

    it('requires the documents permission', async () => {
        const registry = new ToolRegistry();
        registry.registerAll(createDocumentTools(seed()));
        expect(registry.definitions({ permissions: [] })).toEqual([]);
        expect(registry.definitions({ permissions: ['web'] })).toEqual([]);
        expect(registry.definitions({ permissions: [DOCUMENT_PERMISSION] })).toHaveLength(4);
        const denied = await registry.execute(call('document_list', {}), { permissions: [] });
        expect(denied.isError).toBe(true);
        expect(denied.content).toMatch(/not permitted/i);
    });
});
