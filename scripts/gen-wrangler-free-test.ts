import * as fs from 'node:fs/promises';
import { parse, type ParseError } from 'jsonc-parser';

/**
 * Generates the gitignored Containers-free test deployment config.
 *
 * Required: DEPLOY_FREE_TEST_KV_NAMESPACE_ID
 * Optional: DEPLOY_FREE_TEST_KV_PREVIEW_NAMESPACE_ID, DEPLOY_FREE_TEST_WORKER_NAME
 */

const BASE_CONFIG_PATH = 'wrangler.free-test.jsonc';
const DEPLOY_CONFIG_PATH = 'wrangler.free-test.deploy.jsonc';

interface WranglerConfig {
    name?: string;
    keep_vars?: boolean;
    containers?: unknown;
    durable_objects?: { bindings?: { name?: string; class_name?: string }[] };
    exports?: Record<string, unknown>;
    kv_namespaces?: { binding: string; id?: string; preview_id?: string }[];
    vars?: Record<string, unknown>;
    [key: string]: unknown;
}

function fail(message: string): never {
    console.error(`[gen-wrangler-free-test] ${message}`);
    process.exit(1);
}

function isPlaceholder(value?: string): boolean {
    return !value || value === 'local';
}

async function loadBaseConfig(): Promise<WranglerConfig> {
    const errors: ParseError[] = [];
    const config = parse(await fs.readFile(BASE_CONFIG_PATH, 'utf-8'), errors, {
        allowTrailingComma: true,
    }) as WranglerConfig | undefined;
    if (errors.length > 0 || !config || typeof config !== 'object') {
        fail(`failed to read ${BASE_CONFIG_PATH}: invalid JSONC`);
    }
    return config;
}

function assertSafeTestConfig(config: WranglerConfig): void {
    if (config.containers !== undefined) {
        fail('containers must not be present in the free-test configuration');
    }
    const bindings = config.durable_objects?.bindings ?? [];
    if (bindings.some(binding => binding.name === 'SANDBOX' || binding.class_name === 'SandboxDurableObject')) {
        fail('the SANDBOX binding must not be present in the free-test configuration');
    }
    if (!bindings.some(binding => binding.name === 'CODING_SESSION')) {
        fail('the CODING_SESSION binding is required');
    }
    if ('SandboxDurableObject' in (config.exports ?? {})) {
        fail('SandboxDurableObject must not be exported by the free-test Worker');
    }
    if (!('CodingSessionDurableObject' in (config.exports ?? {}))) {
        fail('CodingSessionDurableObject must be exported by the free-test Worker');
    }
    const vars = config.vars ?? {};
    for (const key of [
        'GITHUB_APP_ID',
        'GITHUB_INSTALLATION_ID',
        'GITHUB_INSTALLATION_IDS',
        'GITHUB_API_BASE_URL',
        'GITHUB_ALLOWED_REPOSITORIES',
        'GITHUB_ALLOWED_REPOSITORIES_BY_USER',
        'GITHUB_WRITE_ALLOWED_REPOSITORIES',
    ]) {
        if (vars[key] !== '') {
            fail(`${key} must be an empty string in the free-test configuration`);
        }
    }
    if (vars.SANDBOX_INTERNET !== 'false') {
        fail('SANDBOX_INTERNET must be false in the free-test configuration');
    }
}

async function main() {
    const config = await loadBaseConfig();
    assertSafeTestConfig(config);

    const configId = config.kv_namespaces?.find(item => item.binding === 'DATABASE')?.id;
    const kvNamespaceId = process.env.DEPLOY_FREE_TEST_KV_NAMESPACE_ID || configId;
    if (isPlaceholder(kvNamespaceId)) {
        fail('DEPLOY_FREE_TEST_KV_NAMESPACE_ID is required (or set a real DATABASE id in wrangler.free-test.jsonc).');
    }
    const previewId = process.env.DEPLOY_FREE_TEST_KV_PREVIEW_NAMESPACE_ID || kvNamespaceId;
    config.kv_namespaces = [{ binding: 'DATABASE', id: kvNamespaceId, preview_id: previewId }];
    if (process.env.DEPLOY_FREE_TEST_WORKER_NAME) {
        config.name = process.env.DEPLOY_FREE_TEST_WORKER_NAME;
    }

    await fs.writeFile(DEPLOY_CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`);
    console.log(
        `Generated ${DEPLOY_CONFIG_PATH}: DATABASE -> ${kvNamespaceId}; name -> ${config.name}; Containers -> none`,
    );
}

main().catch(error => {
    fail(error instanceof Error ? error.message : String(error));
});
