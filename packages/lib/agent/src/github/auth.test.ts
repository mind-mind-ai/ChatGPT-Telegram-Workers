import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GitHubAppTokenProvider, createGitHubAppJwt } from './auth';
import { GitHubError } from './errors';
import { normalizeGitHubRepository } from './repository';

function keyPair(type: 'pkcs8' | 'pkcs1' = 'pkcs8') {
    return generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type, format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
}

function decodePart(value: string): Record<string, unknown> {
    const padded = value
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
}

const REPOSITORY = normalizeGitHubRepository('octo/private');

describe('GitHub App JWT', () => {
    it('creates a signed RS256 JWT with the app id and a short lifetime', async () => {
        const { privateKey, publicKey } = keyPair();
        const now = 1_700_000_000_000;
        const jwt = await createGitHubAppJwt({ appId: 12345, privateKey, now: () => now });
        const [header, payload, signature] = jwt.split('.');
        expect(decodePart(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(decodePart(payload)).toMatchObject({ iss: '12345', iat: now / 1000 - 60, exp: now / 1000 + 540 });
        const padded = signature
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(Math.ceil(signature.length / 4) * 4, '=');
        expect(
            verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(padded, 'base64')),
        ).toBe(true);
    });

    it('also accepts GitHub PKCS#1 RSA private keys', async () => {
        const { privateKey } = keyPair('pkcs1');
        await expect(createGitHubAppJwt({ appId: '12345', privateKey })).resolves.toContain('.');
    });
});

describe('GitHubAppTokenProvider', () => {
    it('requests a repository-scoped read-only token and caches it', async () => {
        const { privateKey } = keyPair();
        const calls: { url: string; init?: RequestInit }[] = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init });
            return new Response(
                JSON.stringify({ token: 'ghs_installation_secret', expires_at: '2030-01-01T00:00:00Z' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as typeof fetch;
        const provider = new GitHubAppTokenProvider({
            appId: '12345',
            privateKey,
            fetchImpl,
            apiBaseUrl: 'https://api.github.test',
            now: () => Date.parse('2029-12-31T00:00:00Z'),
        });

        const token = await provider.getInstallationToken('999', REPOSITORY);
        expect(token.token).toBe('ghs_installation_secret');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.github.test/app/installations/999/access_tokens');
        expect(calls[0].init?.method).toBe('POST');
        expect(calls[0].init?.headers).toMatchObject({ authorization: expect.stringMatching(/^Bearer /) });
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({
            repositories: ['private'],
            permissions: { contents: 'read' },
        });

        await provider.getInstallationToken('999', REPOSITORY);
        expect(calls).toHaveLength(1);
    });

    it('requests Contents: write only when explicitly configured', async () => {
        const { privateKey } = keyPair();
        const calls: { init?: RequestInit }[] = [];
        const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ init });
            return new Response(JSON.stringify({ token: 'ghs_write_secret', expires_at: '2030-01-01T00:00:00Z' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;
        const provider = new GitHubAppTokenProvider({
            appId: '12345',
            privateKey,
            contentsPermission: 'write',
            fetchImpl,
            apiBaseUrl: 'https://api.github.test',
            now: () => Date.parse('2029-12-31T00:00:00Z'),
        });

        await provider.getInstallationToken('999', REPOSITORY);
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({
            repositories: ['private'],
            permissions: { contents: 'write' },
        });
    });

    it('maps authentication failures without exposing the token or response body', async () => {
        const { privateKey } = keyPair();
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ message: 'bad credentials ghs_should_not_leak' }), {
                status: 401,
                headers: { 'content-type': 'application/json' },
            })) as typeof fetch;
        const provider = new GitHubAppTokenProvider({
            appId: '12345',
            privateKey,
            fetchImpl,
            apiBaseUrl: 'https://api.github.test',
        });

        await expect(provider.getInstallationToken('999', REPOSITORY)).rejects.toMatchObject({ code: 'auth' });
        try {
            await provider.getInstallationToken('999', REPOSITORY);
        } catch (error) {
            expect((error as Error).message).not.toContain('ghs_should_not_leak');
        }
    });

    it('rejects invalid installation ids before making a request', async () => {
        const { privateKey } = keyPair();
        const fetchImpl = vi.fn() as unknown as typeof fetch;
        const provider = new GitHubAppTokenProvider({
            appId: '12345',
            privateKey,
            fetchImpl,
            apiBaseUrl: 'https://api.github.test',
        });
        await expect(provider.getInstallationToken('../../bad', REPOSITORY)).rejects.toBeInstanceOf(GitHubError);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
