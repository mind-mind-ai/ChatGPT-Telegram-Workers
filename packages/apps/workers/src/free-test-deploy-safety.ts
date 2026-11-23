import * as path from 'node:path';

export const EXPECTED_FREE_TEST_MAIN = 'packages/apps/workers/src/index.free-test.ts';

export class FreeTestDeploySafetyError extends Error {
    readonly name = 'FreeTestDeploySafetyError';
}

function fail(message: string): never {
    throw new FreeTestDeploySafetyError(message);
}

export interface FreeTestDeployConfig {
    name?: unknown;
    main?: unknown;
    containers?: unknown;
    durable_objects?: { bindings?: { name?: string; class_name?: string }[] };
    exports?: Record<string, unknown>;
    kv_namespaces?: { binding?: string; id?: string; preview_id?: string }[];
    vars?: Record<string, unknown>;
    env?: Record<string, unknown>;
    [key: string]: unknown;
}

export function normalizeMainPath(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) {
        return null;
    }
    return path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '');
}

function normalizeConfigName(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        fail('wrangler.jsonc must define a non-empty Worker name');
    }
    return value.trim();
}

function normalizeOptionalEnvName(value: string | undefined, label: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const name = value.trim();
    if (!name) {
        fail(`${label} must not be empty`);
    }
    return name;
}

function sameName(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

export interface ProductionWorkerSources {
    configName?: unknown;
    deployWorkerName?: string;
    explicitProductionWorkerName?: string;
}

export interface ProductionWorkerIdentity {
    actualName: string;
    forbiddenNames: string[];
}

/**
 * Resolves the deployed production name and every known production-name
 * candidate. DEPLOY_WORKER_NAME is the production deploy override and wins
 * over the config default; the explicit value must confirm the actual name.
 */
export function resolveProductionWorkerIdentity(sources: ProductionWorkerSources): ProductionWorkerIdentity {
    const configName = normalizeConfigName(sources.configName);
    const deployName = normalizeOptionalEnvName(sources.deployWorkerName, 'DEPLOY_WORKER_NAME');
    const explicitName = normalizeOptionalEnvName(
        sources.explicitProductionWorkerName,
        'DEPLOY_FREE_TEST_PRODUCTION_WORKER_NAME',
    );
    const actualName = deployName ?? configName;
    if (explicitName && !sameName(explicitName, actualName)) {
        fail('DEPLOY_FREE_TEST_PRODUCTION_WORKER_NAME does not match the resolved production Worker name');
    }
    const forbiddenNames: string[] = [];
    for (const name of [configName, deployName, explicitName]) {
        if (name && !forbiddenNames.some(candidate => sameName(candidate, name))) {
            forbiddenNames.push(name);
        }
    }
    return { actualName, forbiddenNames };
}

export interface ProductionKvSources {
    deployKvNamespaceId?: string;
    explicitProductionKvNamespaceId?: string;
    productionConfigKvNamespaceId?: string;
}

function validateKvNamespaceId(id: string, label: string): string {
    if (!/^[0-9a-f]{32}$/i.test(id)) {
        fail(`${label} must be a 32-character hexadecimal KV namespace id`);
    }
    return id;
}

function normalizeKvEnvNamespaceId(value: string | undefined, label: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const id = value.trim();
    if (!id || id === 'local') {
        fail(`${label} must not be empty or the local placeholder`);
    }
    return validateKvNamespaceId(id, label);
}

function normalizeConfigKvNamespaceId(value: string | undefined, label: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const id = value.trim();
    if (!id || id === 'local') {
        return undefined;
    }
    return validateKvNamespaceId(id, label);
}

export function requiredKvNamespaceId(value: string | undefined, label: string): string {
    const id = value?.trim();
    if (!id || id === 'local') {
        fail(`${label} is required and must not be the local placeholder`);
    }
    return validateKvNamespaceId(id, label);
}

/**
 * Requires an explicit production DATABASE id confirmation. DEPLOY_KV_NAMESPACE_ID
 * and a real production config id are optional cross-checks; any mismatch fails.
 */
export function resolveProductionKvNamespaceId(sources: ProductionKvSources): string {
    const explicitId = normalizeKvEnvNamespaceId(
        sources.explicitProductionKvNamespaceId,
        'DEPLOY_FREE_TEST_PRODUCTION_KV_NAMESPACE_ID',
    );
    if (!explicitId) {
        fail('DEPLOY_FREE_TEST_PRODUCTION_KV_NAMESPACE_ID is required to confirm the production DATABASE id');
    }
    const deployId = normalizeKvEnvNamespaceId(sources.deployKvNamespaceId, 'DEPLOY_KV_NAMESPACE_ID');
    const configId = normalizeConfigKvNamespaceId(sources.productionConfigKvNamespaceId, 'wrangler.jsonc DATABASE id');
    for (const [label, id] of [
        ['DEPLOY_KV_NAMESPACE_ID', deployId],
        ['wrangler.jsonc DATABASE id', configId],
    ] as const) {
        if (id && id.toLowerCase() !== explicitId.toLowerCase()) {
            fail(`${label} does not match DEPLOY_FREE_TEST_PRODUCTION_KV_NAMESPACE_ID`);
        }
    }
    return explicitId;
}

export interface KvNamespaceRef {
    label: string;
    value: string | undefined;
}

/** Collects top-level and env.* KV ids and preview ids for isolation checks. */
export function collectKvNamespaceRefs(config: FreeTestDeployConfig, prefix = ''): KvNamespaceRef[] {
    const refs: KvNamespaceRef[] = [];
    for (const [index, item] of (config.kv_namespaces ?? []).entries()) {
        const label = `${prefix}kv_namespaces[${index}] (${item.binding ?? 'unknown'})`;
        refs.push({ label, value: item.id }, { label: `${label} preview_id`, value: item.preview_id });
    }
    for (const [name, envConfig] of Object.entries(config.env ?? {})) {
        if (envConfig && typeof envConfig === 'object' && !Array.isArray(envConfig)) {
            refs.push(...collectKvNamespaceRefs(envConfig as FreeTestDeployConfig, `${prefix}env.${name}.`));
        }
    }
    return refs;
}

export function assertNoProductionKvId(productionId: string, value: string | undefined, label: string): void {
    const id = normalizeConfigKvNamespaceId(value, label);
    if (id && id.toLowerCase() === productionId.toLowerCase()) {
        fail(`${label} must not match the production DATABASE namespace`);
    }
}

export function assertWorkerNameNotProduction(value: string, productionNames: string[], label: string): string {
    const name = value.trim();
    if (!name) {
        fail(`${label} must not be empty`);
    }
    for (const productionName of productionNames) {
        if (sameName(name, productionName)) {
            fail(`${label} must not be the production Worker name (${productionName})`);
        }
    }
    return name;
}

export function assertSafeFreeTestConfig(config: FreeTestDeployConfig, productionNames: string[]): void {
    if (normalizeMainPath(config.main) !== EXPECTED_FREE_TEST_MAIN) {
        fail(`main must point exactly to ${EXPECTED_FREE_TEST_MAIN}`);
    }
    if (typeof config.name !== 'string' || !config.name.trim()) {
        fail('wrangler.free-test.jsonc must define a non-empty Worker name');
    }
    for (const productionName of productionNames) {
        if (sameName(config.name.trim(), productionName)) {
            fail(`Worker name must not be the production Worker name (${productionName})`);
        }
    }
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
