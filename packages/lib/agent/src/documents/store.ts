import type { DocumentRecord } from './types';

/** Request-scoped document store. Document text is never persisted to chat history. */
export class DocumentStore {
    private readonly documents = new Map<string, DocumentRecord>();

    add(document: Omit<DocumentRecord, 'id'>): DocumentRecord {
        const id = `doc${this.documents.size + 1}`;
        const record: DocumentRecord = { ...document, id };
        this.documents.set(id, record);
        return record;
    }

    get(id: string): DocumentRecord | undefined {
        return this.documents.get(id);
    }

    list(): DocumentRecord[] {
        return [...this.documents.values()];
    }

    get size(): number {
        return this.documents.size;
    }
}
