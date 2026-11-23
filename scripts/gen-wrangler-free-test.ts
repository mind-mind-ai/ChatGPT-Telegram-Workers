import * as fs from 'node:fs/promises';
import { parse, type ParseError } from 'jsonc-parser';
import {
    assertNoProductionKvId,
    assertSafeFreeTestConfig,
    assertWorkerNameNotProduction,
    collectKvNamespaceRefs,
    requiredKvNamespaceId,
    resolveProductionKvNamespaceId,
    resolveProductionWorkerIdentity,
    type FreeTestDeployConfig,
} from '../packages/apps/workers/src/free-test-deploy-safety';

/**
 * Generates the gitignored Containers-free test deployment config.
 *
 * Production identity is resolved from the same sources as the production
 * deploy: DEPLOY_WORKER_NAME / DEPLOY_KV_NAMESPACE_ID, the explicit
 * DEPLOY_FREE_TEST_PRODUCTION_* comparison settings, and real ids in
 * wrangler.jsonc. Conflicting or missing sources fail closed.
 *
 * Required:
 * - DEPLOY_FREE_TEST_KV_NAMESPACE_ID (or a real DATABASE id in the free-test config)
 * - DEPLOY_FREE_TEST_PRODUCTION_KV_NAMESPACE_ID
 *
 * Optional cross-checks:
 * - DEPLOY_KV_NAMESPACE_ID and a real production DATABASE id in wrangler.jsonc
 * - DEPLOY_WORKER_NAME and DEPLOY_FREE_TEST_PRODUCTION_WORKER_NAME
 * - DEPLOY_FREE_TEST_KV_PREVIEW_NAMESPACE_ID
 * - DEPLOY_FREE_TEST_WORKER_NAME
 */

const BASE_CONFIG_PATH = 'wrangler.free-test.jsonc';
const PRODUCTION_CONFIG_PATH = 'wrangler.jsonc';
const DEPLOY_CONFIG_PATH = 'wrangler.free-test.deploy.jsonc';

type WranglerConfig = FreeTestDeployConfig;

function fail(message: string): never {
    console.error(`[gen-wrangler-free-test] ${message}`);
    process.exit(1);
}

async function loadConfig(configPath: string): Promise<WranglerConfig> {
    const errors: ParseError[] = [];
    const config = parse(await fs.readFile(configPath, 'utf-8'), errors, {
        allowTrailingComma: true,
    }) as WranglerConfig | undefined;
    if (errors.length > 0 || !config || typeof config !== 'object') {
        fail(`failed to read ${configPath}: invalid JSONC`);
    }
    return config;
}

async function main() {
    const config = await loadConfig(BASE_CONFIG_PATH);
    const productionConfig = await loadConfig(PRODUCTION_CONFIG_PATH);

    const productionIdentity = resolveProductionWorkerIdentity({
        configName: productionConfig.name,
        deployWorkerName: process.env.DEPLOY_WORKER_NAME,
        explicitProductionWorkerName: process.env.DEPLOY_FREE_TEST_PRODUCTION_WORKER_NAME,
    });
    assertSafeFreeTestConfig(config, productionIdentity.forbiddenNames);

    const productionKvNamespaceId = resolveProductionKvNamespaceId({
        deployKvNamespaceId: process.env.DEPLOY_KV_NAMESPACE_ID,
        explicitProductionKvNamespaceId: process.env.DEPLOY_FREE_TEST_PRODUCTION_KV_NAMESPACE_ID,
        productionConfigKvNamespaceId: productionConfig.kv_namespaces?.find(item => item.binding === 'DATABASE')?.id,
    });

    for (const ref of collectKvNamespaceRefs(config)) {
        assertNoProductionKvId(productionKvNamespaceId, ref.value, `${BASE_CONFIG_PATH} ${ref.label}`);
    }

    const baseKvNamespaces = config.kv_namespaces ?? [];
    const configId = baseKvNamespaces.find(item => item.binding === 'DATABASE')?.id;
    const kvNamespaceId = requiredKvNamespaceId(
        process.env.DEPLOY_FREE_TEST_KV_NAMESPACE_ID || configId,
        'DEPLOY_FREE_TEST_KV_NAMESPACE_ID',
    );
    assertNoProductionKvId(productionKvNamespaceId, kvNamespaceId, 'DEPLOY_FREE_TEST_KV_NAMESPACE_ID');

    const previewId = requiredKvNamespaceId(
        process.env.DEPLOY_FREE_TEST_KV_PREVIEW_NAMESPACE_ID || kvNamespaceId,
        'DEPLOY_FREE_TEST_KV_PREVIEW_NAMESPACE_ID',
    );
    assertNoProductionKvId(productionKvNamespaceId, previewId, 'DEPLOY_FREE_TEST_KV_PREVIEW_NAMESPACE_ID');

    const workerNameOverride = process.env.DEPLOY_FREE_TEST_WORKER_NAME;
    if (workerNameOverride !== undefined) {
        config.name = assertWorkerNameNotProduction(
            workerNameOverride,
            productionIdentity.forbiddenNames,
            'DEPLOY_FREE_TEST_WORKER_NAME',
        );
    }

    config.kv_namespaces = [{ binding: 'DATABASE', id: kvNamespaceId, preview_id: previewId }];
    await fs.writeFile(DEPLOY_CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`);
    console.log(
        `Generated ${DEPLOY_CONFIG_PATH}: DATABASE -> ${kvNamespaceId}; name -> ${config.name}; Containers -> none`,
    );
}

main().catch(error => {
    fail(error instanceof Error ? error.message : String(error));
});
