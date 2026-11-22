export class UnsafeUrlError extends Error {
    readonly name = 'UnsafeUrlError';
}

const BLOCKED_HOSTS = new Set([
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    'broadcasthost',
    'metadata',
    'instance-data',
]);

const BLOCKED_HOST_SUFFIXES = [
    '.localhost',
    '.local',
    '.localdomain',
    '.internal',
    '.intranet',
    '.corp',
    '.private',
    '.home',
    '.home.arpa',
    '.lan',
    '.test',
    '.invalid',
    '.example',
    '.onion',
    '.alt',
];

function normalizeHostname(hostname: string): string {
    return hostname
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.+$/, '');
}

function isIpv4Literal(host: string): boolean {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function isIpv6Literal(host: string): boolean {
    return host.includes(':');
}

export function isBlockedIpv4(host: string): boolean {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
}

export function isBlockedIpv6(host: string): boolean {
    const normalized = host.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;

    if (normalized.startsWith('::ffff:')) {
        return isBlockedIpv4(normalized.slice('::ffff:'.length));
    }

    const first = normalized.split(':')[0] || '0';
    const firstValue = Number.parseInt(first, 16);
    if (Number.isNaN(firstValue)) return true;

    // fc00::/7 unique local
    if ((firstValue & 0xfe00) === 0xfc00) return true;
    // fe80::/10 link local
    if ((firstValue & 0xffc0) === 0xfe80) return true;
    // ff00::/8 multicast
    if ((firstValue & 0xff00) === 0xff00) return true;
    // 2002::/16 6to4 and 2001:0000::/32 Teredo can embed private IPv4
    if (firstValue === 0x2002) return true;
    if (/^2001:0{1,4}:/i.test(normalized)) return true;
    // 2001:db8::/32 documentation
    if (/^2001:0?db8:/i.test(normalized)) return true;
    // Only global unicast 2000::/3 is allowed for IPv6 literals.
    if (firstValue < 0x2000 || firstValue > 0x3fff) return true;

    return false;
}

export function isBlockedHostname(hostname: string): boolean {
    const host = normalizeHostname(hostname);
    if (!host) return true;
    if (BLOCKED_HOSTS.has(host)) return true;
    if (BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return true;
    if (isIpv4Literal(host)) return isBlockedIpv4(host);
    if (isIpv6Literal(host)) return isBlockedIpv6(host);
    // Single-label names are almost always internal hosts.
    if (!host.includes('.')) return true;
    return false;
}

/**
 * Validates a URL before any outbound request. The WHATWG URL parser also
 * normalizes numeric IPv4 forms such as http://2130706433/ to 127.0.0.1.
 */
export function assertSafeHttpUrl(raw: string | URL): URL {
    let url: URL;
    try {
        url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
    } catch {
        throw new UnsafeUrlError('Invalid URL');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UnsafeUrlError('Only http and https URLs are allowed');
    }
    if (url.username || url.password) {
        throw new UnsafeUrlError('URLs with credentials are not allowed');
    }

    const host = normalizeHostname(url.hostname);
    if (!host) {
        throw new UnsafeUrlError('URL must include a host');
    }
    if (isBlockedHostname(host)) {
        throw new UnsafeUrlError(`Blocked host: ${host}`);
    }
    if (url.port && url.port !== '80' && url.port !== '443') {
        throw new UnsafeUrlError('Only ports 80 and 443 are allowed');
    }

    return url;
}
