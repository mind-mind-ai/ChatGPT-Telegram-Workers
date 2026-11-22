export interface HtmlAnchor {
    href: string;
    text: string;
    className: string;
}

export interface ExtractedLink {
    title: string;
    url: string;
}

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    copy: '©',
    reg: '®',
    trade: '™',
};

export function decodeHtmlEntities(input: string): string {
    return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
            const code = Number.parseInt(entity.slice(2), 16);
            return decodeCodePoint(code, match);
        }
        if (entity.startsWith('#')) {
            const code = Number.parseInt(entity.slice(1), 10);
            return decodeCodePoint(code, match);
        }
        return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

function decodeCodePoint(code: number, fallback: string): string {
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
        return fallback;
    }
    try {
        return String.fromCodePoint(code);
    } catch {
        return fallback;
    }
}

function removeNonContentBlocks(html: string): string {
    return html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
        .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, ' ')
        .replace(/<embed\b[^>]*>/gi, ' ')
        .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ');
}

export function normalizeWhitespace(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function stripTags(html: string): string {
    return html.replace(/<[^>]*>/g, ' ');
}

export function extractTitle(html: string): string {
    const match = removeNonContentBlocks(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (!match) {
        return '';
    }
    return normalizeWhitespace(decodeHtmlEntities(stripTags(match[1])));
}

export function htmlToText(html: string): string {
    const withoutHead = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
    const text = removeNonContentBlocks(withoutHead)
        .replace(/<(?:br|hr)\b[^>]*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<\/(?:p|div|section|article|header|footer|li|tr|table|ul|ol|h[1-6]|blockquote|pre)>/gi, '\n')
        .replace(/<(?:p|div|section|article|header|footer|tr|table|ul|ol|h[1-6]|blockquote|pre)\b[^>]*>/gi, '\n')
        .replace(/<(?:td|th)\b[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');

    return normalizeWhitespace(decodeHtmlEntities(text));
}

function getAttribute(attributes: string, name: string): string | null {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = attributes.match(pattern);
    if (!match) {
        return null;
    }
    return match[1] ?? match[2] ?? match[3] ?? null;
}

export function extractAnchors(html: string): HtmlAnchor[] {
    const anchors: HtmlAnchor[] = [];
    const source = removeNonContentBlocks(html);
    const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
        const href = getAttribute(match[1], 'href');
        anchors.push({
            href: href ? decodeHtmlEntities(href) : '',
            text: normalizeWhitespace(decodeHtmlEntities(stripTags(match[2]))),
            className: getAttribute(match[1], 'class') ?? '',
        });
    }
    return anchors;
}

export function extractLinks(html: string, baseUrl: string, limit = 10): ExtractedLink[] {
    const seen = new Set<string>();
    const links: ExtractedLink[] = [];
    for (const anchor of extractAnchors(html)) {
        if (
            !anchor.href ||
            anchor.href.startsWith('#') ||
            /^(?:javascript|mailto|tel|data|blob|about):/i.test(anchor.href)
        ) {
            continue;
        }
        let url: URL;
        try {
            url = new URL(anchor.href, baseUrl);
        } catch {
            continue;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            continue;
        }
        if (url.username || url.password) {
            continue;
        }
        url.hash = '';
        const href = url.toString();
        if (seen.has(href)) {
            continue;
        }
        seen.add(href);
        links.push({
            title: (anchor.text || href).slice(0, 160),
            url: href,
        });
        if (links.length >= limit) {
            break;
        }
    }
    return links;
}
