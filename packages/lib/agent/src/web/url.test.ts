import { assertSafeHttpUrl, isBlockedHostname, UnsafeUrlError } from './url';

describe('URL safety', () => {
    it.each([
        'https://example.com/',
        'http://example.com/path?q=1',
        'https://sub.example.co.uk/a',
        'http://example.com:80/',
        'https://example.com:443/',
        'https://[2001:4860:4860::8888]/',
    ])('allows public URL %s', url => {
        expect(() => assertSafeHttpUrl(url)).not.toThrow();
    });

    it.each([
        'file:///etc/passwd',
        'ftp://example.com/',
        'javascript:alert(1)',
        'data:text/plain,hello',
        'http://localhost/',
        'http://localhost.localdomain/',
        'http://foo.local/',
        'http://foo.localdomain/',
        'http://foo.internal/',
        'http://foo.home.arpa/',
        'http://intranet/',
        'http://127.0.0.1/',
        'http://10.1.2.3/',
        'http://172.16.0.1/',
        'http://192.168.1.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://100.64.0.1/',
        'http://198.18.0.1/',
        'http://192.0.2.1/',
        'http://198.51.100.1/',
        'http://203.0.113.1/',
        'http://224.0.0.1/',
        'http://[::1]/',
        'http://[fc00::1]/',
        'http://[fe80::1]/',
        'http://[ff02::1]/',
        'http://[2001:db8::1]/',
        'http://[2002:7f00:1::]/',
        'http://user:pass@example.com/',
        'http://example.com:8080/',
        'http://2130706433/',
        'http://0x7f000001/',
    ])('blocks unsafe URL %s', url => {
        expect(() => assertSafeHttpUrl(url)).toThrow(UnsafeUrlError);
    });

    it('rejects malformed URLs', () => {
        expect(() => assertSafeHttpUrl('not a url')).toThrow(UnsafeUrlError);
        expect(() => assertSafeHttpUrl('')).toThrow(UnsafeUrlError);
    });

    it('identifies internal hostnames directly', () => {
        expect(isBlockedHostname('example.com')).toBe(false);
        expect(isBlockedHostname('localhost')).toBe(true);
        expect(isBlockedHostname('service.internal')).toBe(true);
        expect(isBlockedHostname('10.0.0.1')).toBe(true);
        expect(isBlockedHostname('::1')).toBe(true);
    });
});
