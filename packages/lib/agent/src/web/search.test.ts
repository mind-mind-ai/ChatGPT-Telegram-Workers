import { HttpStatusError } from './http';
import {
    createWebSearchTool,
    DuckDuckGoHtmlSearchProvider,
    parseDuckDuckGoResults,
    type WebSearchProvider,
} from './search';

const DDG_HTML = `
<div class="result results_links">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=x">One &amp; Only</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First <b>snippet</b></a>
    <a rel="nofollow" class="result__a" href="https://example.org/two">Two</a>
    <a class="result__snippet">Second snippet</a>
</div>
`;

function contentOf(result: Awaited<ReturnType<ReturnType<typeof createWebSearchTool>['execute']>>): string {
    return typeof result === 'string' ? result : result.content;
}

const context = {
    toolCallId: 'c1',
    signal: new AbortController().signal,
    access: { permissions: ['web'] },
};

describe('DuckDuckGo HTML search', () => {
    it('parses titles, snippets and original URLs', () => {
        const results = parseDuckDuckGoResults(DDG_HTML, 'https://html.duckduckgo.com/html/', 5);

        expect(results).toEqual([
            { title: 'One & Only', snippet: 'First snippet', url: 'https://example.com/one' },
            { title: 'Two', snippet: 'Second snippet', url: 'https://example.org/two' },
        ]);
    });

    it('respects maxResults and sends the query to the endpoint', async () => {
        const fetchImpl = vi.fn(
            async () => new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
        ) as unknown as typeof fetch;
        const provider = new DuckDuckGoHtmlSearchProvider({ fetchImpl });

        const results = await provider.search('cloudflare workers', { maxResults: 1 });

        expect(results).toEqual([{ title: 'One & Only', snippet: 'First snippet', url: 'https://example.com/one' }]);
        const calledUrl = new URL(String((fetchImpl as any).mock.calls[0][0]));
        expect(calledUrl.searchParams.get('q')).toBe('cloudflare workers');
    });

    it('surfaces provider HTTP errors', async () => {
        const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
        const provider = new DuckDuckGoHtmlSearchProvider({ fetchImpl });

        await expect(provider.search('test')).rejects.toBeInstanceOf(HttpStatusError);
    });
});

describe('web_search tool', () => {
    it('requires the web permission by default', () => {
        const tool = createWebSearchTool();
        expect(tool.name).toBe('web_search');
        expect(tool.requiredPermissions).toEqual(['web']);
    });

    it('formats results with titles, snippets and source URLs', async () => {
        const provider: WebSearchProvider = {
            name: 'fake',
            search: vi.fn(async () => [
                { title: 'Result title', snippet: 'Result snippet', url: 'https://example.com/source' },
            ]),
        };
        const tool = createWebSearchTool({ provider });

        const content = contentOf(await tool.execute({ query: 'hello' }, context));

        expect(content).toContain('Result title');
        expect(content).toContain('Snippet: Result snippet');
        expect(content).toContain('URL: https://example.com/source');
        expect(content).toContain('UNTRUSTED_WEB_CONTENT');
    });

    it('rejects empty queries and clamps max_results', async () => {
        const search = vi.fn(async () => []);
        const provider: WebSearchProvider = { name: 'fake', search };
        const tool = createWebSearchTool({ provider });

        const empty = await tool.execute({ query: '   ' }, context);
        expect(empty).toMatchObject({ isError: true });

        const noResults = await tool.execute({ query: 'test', max_results: 999 }, context);
        expect(noResults).toBe('No web search results for "test".');
        expect(search).toHaveBeenCalledWith('test', expect.objectContaining({ maxResults: 10 }));
    });

    it('returns tool errors as isError results', async () => {
        const provider: WebSearchProvider = {
            name: 'fake',
            search: vi.fn(async () => {
                throw new Error('provider down');
            }),
        };
        const tool = createWebSearchTool({ provider });

        const result = await tool.execute({ query: 'test' }, context);
        expect(result).toMatchObject({ isError: true });
        expect(contentOf(result)).toContain('Web search failed: provider down');
    });
});
