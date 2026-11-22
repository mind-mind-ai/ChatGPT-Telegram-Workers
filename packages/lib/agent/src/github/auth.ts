import { GitHubError } from './errors';
import {
    DEFAULT_GITHUB_API_BASE_URL,
    DEFAULT_GITHUB_TIMEOUT_MS,
    fetchGitHubResponse,
    mapGitHubHttpError,
    readGitHubResponseJson,
} from './http';
import { repositoryKey } from './repository';
import type { GitHubRepositoryRef } from './types';

export interface GitHubInstallationToken {
    token: string;
    expiresAt: number;
}

export interface GitHubTokenOptions {
    signal?: AbortSignal;
}

export interface GitHubTokenProvider {
    getInstallationToken(
        installationId: string,
        repository: GitHubRepositoryRef,
        options?: GitHubTokenOptions,
    ): Promise<GitHubInstallationToken>;
}

export interface GitHubAppTokenProviderOptions {
    appId: string | number;
    privateKey: string;
    /** Contents permission requested for the repository-scoped installation token. */
    contentsPermission?: 'read' | 'write';
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
    timeoutMs?: number;
    now?: () => number;
}

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_FALLBACK_LIFETIME_MS = 50 * 60_000;

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodePemBody(pem: string): Uint8Array {
    const binary = atob(pem.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}

function derLength(length: number): Uint8Array {
    if (length < 0x80) {
        return Uint8Array.of(length);
    }
    const bytes: number[] = [];
    let remaining = length;
    while (remaining > 0) {
        bytes.unshift(remaining & 0xff);
        remaining >>>= 8;
    }
    return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, content: Uint8Array): Uint8Array {
    return concatBytes(Uint8Array.of(tag), derLength(content.byteLength), content);
}

/** Web Crypto imports PKCS#8, while GitHub also emits PKCS#1 PEM keys. */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
    const rsaAlgorithm = der(
        0x30,
        concatBytes(
            Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01),
            Uint8Array.of(0x05, 0x00),
        ),
    );
    const privateKey = der(0x04, pkcs1);
    const version = Uint8Array.of(0x02, 0x01, 0x00);
    return der(0x30, concatBytes(version, rsaAlgorithm, privateKey));
}

async function importPrivateKey(privateKey: string): Promise<CryptoKey> {
    const normalized = privateKey.replace(/\\n/g, '\n').trim();
    const match = normalized.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
    if (!match) {
        throw new GitHubError('auth', 'GitHub App private key is not a PEM key');
    }
    const label = match[1];
    const body = decodePemBody(match[2]);
    const pkcs8 = label === 'PRIVATE KEY' ? body : label === 'RSA PRIVATE KEY' ? wrapPkcs1InPkcs8(body) : null;
    if (!pkcs8) {
        throw new GitHubError('auth', 'GitHub App private key must be an unencrypted RSA key');
    }
    try {
        return await crypto.subtle.importKey(
            'pkcs8',
            pkcs8 as unknown as BufferSource,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['sign'],
        );
    } catch (error) {
        throw new GitHubError('auth', 'GitHub App private key could not be imported', { cause: error });
    }
}

export async function createGitHubAppJwt(options: {
    appId: string | number;
    privateKey: string;
    now?: () => number;
}): Promise<string> {
    const appId = `${options.appId}`.trim();
    if (!/^\d{1,20}$/.test(appId)) {
        throw new GitHubError('invalid-config', 'GitHub App id must be numeric');
    }
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = base64UrlEncode(
        new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId })),
    );
    const unsigned = `${header}.${payload}`;
    const key = await importPrivateKey(options.privateKey);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Exchanges a GitHub App JWT for a repository-scoped installation token. */
export class GitHubAppTokenProvider implements GitHubTokenProvider {
    private readonly appId: string;
    private readonly privateKey: string;
    private readonly fetchImpl: typeof fetch | undefined;
    private readonly apiBaseUrl: string;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly contentsPermission: 'read' | 'write';
    private readonly cache = new Map<string, GitHubInstallationToken>();

    constructor(options: GitHubAppTokenProviderOptions) {
        this.appId = `${options.appId}`.trim();
        this.privateKey = options.privateKey;
        this.fetchImpl = options.fetchImpl;
        this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, '');
        this.timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
        this.contentsPermission = options.contentsPermission ?? 'read';
    }

    async getInstallationToken(
        installationId: string,
        repository: GitHubRepositoryRef,
        options: GitHubTokenOptions = {},
    ): Promise<GitHubInstallationToken> {
        if (!/^\d{1,20}$/.test(installationId)) {
            throw new GitHubError('invalid-config', 'GitHub installation id must be numeric');
        }
        const cacheKey = `${installationId}:${repositoryKey(repository)}:${this.contentsPermission}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
            return cached;
        }

        const jwt = await createGitHubAppJwt({
            appId: this.appId,
            privateKey: this.privateKey,
            now: this.now,
        });
        const response = await fetchGitHubResponse(
            `${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`,
            {
                fetchImpl: this.fetchImpl,
                signal: options.signal,
                timeoutMs: this.timeoutMs,
                method: 'POST',
                headers: {
                    authorization: `Bearer ${jwt}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    repositories: [repository.name],
                    permissions: { contents: this.contentsPermission },
                }),
            },
        );
        if (!response.ok) {
            throw mapGitHubHttpError(response);
        }

        const payload = await readGitHubResponseJson<{ token?: unknown; expires_at?: unknown }>(
            response,
            64 * 1024,
            options.signal,
            this.timeoutMs,
        );
        if (typeof payload.token !== 'string' || !payload.token) {
            throw new GitHubError('auth', 'GitHub did not return an installation token');
        }
        const expiresAt =
            typeof payload.expires_at === 'string' && Number.isFinite(Date.parse(payload.expires_at))
                ? Date.parse(payload.expires_at)
                : this.now() + TOKEN_FALLBACK_LIFETIME_MS;
        const token = { token: payload.token, expiresAt };
        this.cache.set(cacheKey, token);
        return token;
    }
}
