import { decodeHtmlEntities, extractLinks, extractTitle, htmlToText, normalizeWhitespace } from './html';

describe('HTML extraction', () => {
    const page = `
        <!doctype html>
        <html>
            <head>
                <title>Hello &amp; World</title>
                <style>body { color: red; }</style>
            </head>
            <body>
                <script>alert('do not read')</script>
                <h1>Heading</h1>
                <p>Hello&nbsp;world &amp; friends.</p>
                <ul><li>One</li><li>Two</li></ul>
                <a href="/next">Next page</a>
                <a href="https://example.org/absolute">Absolute</a>
                <a href="/next#fragment">Duplicate</a>
                <a href="javascript:alert(1)">Bad</a>
                <a href="mailto:test@example.com">Mail</a>
            </body>
        </html>
    `;

    it('decodes named and numeric entities', () => {
        expect(decodeHtmlEntities('&amp; &lt; &gt; &quot; &#39; &#x41;')).toBe('& < > " \' A');
    });

    it('extracts the page title', () => {
        expect(extractTitle(page)).toBe('Hello & World');
        expect(extractTitle('<html><body>No title</body></html>')).toBe('');
    });

    it('converts HTML to readable text and removes scripts/styles', () => {
        const text = htmlToText(page);

        expect(text).toContain('Heading');
        expect(text).toContain('Hello world & friends.');
        expect(text).toContain('- One');
        expect(text).toContain('- Two');
        expect(text).not.toContain('alert');
        expect(text).not.toContain('color: red');
    });

    it('extracts absolute links, deduplicates and skips unsafe schemes', () => {
        const links = extractLinks(page, 'https://example.com/page', 10);

        expect(links).toEqual([
            { title: 'Next page', url: 'https://example.com/next' },
            { title: 'Absolute', url: 'https://example.org/absolute' },
        ]);
    });

    it('normalizes whitespace without destroying paragraphs', () => {
        expect(normalizeWhitespace(' a \n\n\n b\t c ')).toBe('a\n\nb c');
    });
});
