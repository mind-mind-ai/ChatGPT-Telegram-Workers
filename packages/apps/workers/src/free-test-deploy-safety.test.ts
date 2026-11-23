import { describe, expect, it } from 'vitest';
import {
    EXPECTED_FREE_TEST_MAIN,
    FreeTestDeploySafetyError,
    assertNoProductionKvId,
    assertSafeFreeTestConfig,
    assertWorkerNameNotProduction,
    collectKvNamespaceRefs,
    normalizeMainPath,
    requiredKvNamespaceId,
    resolveProductionKvNamespaceId,
    resolveProductionWorkerIdentity,
    type FreeTestDeployConfig,
} from './free-test-deploy-safety';

const PRODUCTION_NAME = 'chatgpt-telegram-workers';
const FREE_TEST_NAME = 'chatgpt-telegram-workers-free-test';
const PRODUCTION_KV = 'a'.repeat(32);
const FREE_TEST_KV = 'b'.repeat(32);

function safeConfig(overrides: FreeTestDeployConfig = {}): FreeTestDeployConfig {
    return {
        name: FREE_TEST_NAME,
        main: `./${EXPECTED_FREE_TEST_MAIN}`,
        durable_objects: {
            bindings: [{ name: 'CODING_SESSION', class_name: 'CodingSessionDurableObject' }],
        },
        exports: { CodingSessionDurableObject: {} },
        vars: {
            GITHUB_APP_ID: '',
            GITHUB_INSTALLATION_ID: '',
            GITHUB_INSTALLATION_IDS: '',
            GITHUB_API_BASE_URL: '',
            GITHUB_ALLOWED_REPOSITORIES: '',
            GITHUB_ALLOWED_REPOSITORIES_BY_USER: '',
            GITHUB_WRITE_ALLOWED_REPOSITORIES: '',
            SANDBOX_INTERNET: 'false',
        },
        ...overrides,
    };
}

describe('Free-test deploy safety', () => {
    it('resolves the production Worker name from the config by default', () => {
        const identity = resolveProductionWorkerIdentity({ configName: PRODUCTION_NAME });
        expect(identity.actualName).toBe(PRODUCTION_NAME);
        expect(identity.forbiddenNames).toEqual([PRODUCTION_NAME]);
    });

    it('uses DEPLOY_WORKER_NAME as the production Worker name override and keeps both candidates forbidden', () => {
        const identity = resolveProductionWorkerIdentity({
            configName: PRODUCTION_NAME,
            deployWorkerName: 'production-custom',
        });
        expect(identity.actualName).toBe('production-custom');
        expect(identity.forbiddenNames).toEqual([PRODUCTION_NAME, 'production-custom']);
        expect(() => assertWorkerNameNotProduction(PRODUCTION_NAME, identity.forbiddenNames, 'name')).toThrow(
            FreeTestDeploySafetyError,
        );
    });

    it('rejects conflicting production Worker name sources', () => {
        expect(() =>
            resolveProductionWorkerIdentity({
                configName: PRODUCTION_NAME,
                deployWorkerName: 'production-custom',
                explicitProductionWorkerName: PRODUCTION_NAME,
            }),
        ).toThrow(FreeTestDeploySafetyError);
    });

    it('fails closed when the production Worker name cannot be determined', () => {
        expect(() => resolveProductionWorkerIdentity({})).toThrow(FreeTestDeploySafetyError);
        expect(() => resolveProductionWorkerIdentity({ explicitProductionWorkerName: PRODUCTION_NAME })).toThrow(
            FreeTestDeploySafetyError,
        );
    });

    it('rejects a Free-test Worker name equal to any known production name', () => {
        expect(() =>
            assertWorkerNameNotProduction(PRODUCTION_NAME, [PRODUCTION_NAME, 'production-custom'], 'name'),
        ).toThrow(FreeTestDeploySafetyError);
        expect(() =>
            assertWorkerNameNotProduction('production-custom', [PRODUCTION_NAME, 'production-custom'], 'name'),
        ).toThrow(FreeTestDeploySafetyError);
    });

    it('accepts a distinct Free-test Worker name', () => {
        expect(assertWorkerNameNotProduction(FREE_TEST_NAME, [PRODUCTION_NAME], 'name')).toBe(FREE_TEST_NAME);
    });

    it('requires the free-test main entrypoint and rejects a production base name', () => {
        expect(() =>
            assertSafeFreeTestConfig(safeConfig({ main: './packages/apps/workers/src/index.ts' }), [PRODUCTION_NAME]),
        ).toThrow(FreeTestDeploySafetyError);
        expect(() => assertSafeFreeTestConfig(safeConfig({ name: PRODUCTION_NAME }), [PRODUCTION_NAME])).toThrow(
            FreeTestDeploySafetyError,
        );
        expect(() => assertSafeFreeTestConfig(safeConfig(), [PRODUCTION_NAME])).not.toThrow();
    });

    it('requires DEPLOY_FREE_TEST_PRODUCTION_KV_NAMESPACE_ID and accepts it alone', () => {
        expect(resolveProductionKvNamespaceId({ explicitProductionKvNamespaceId: PRODUCTION_KV })).toBe(PRODUCTION_KV);
        expect(() => resolveProductionKvNamespaceId({ deployKvNamespaceId: PRODUCTION_KV })).toThrow(
            FreeTestDeploySafetyError,
        );
        expect(() => resolveProductionKvNamespaceId({})).toThrow(FreeTestDeploySafetyError);
    });

    it('accepts matching deploy and config cross-checks', () => {
        expect(
            resolveProductionKvNamespaceId({
                deployKvNamespaceId: PRODUCTION_KV,
                explicitProductionKvNamespaceId: PRODUCTION_KV,
                productionConfigKvNamespaceId: PRODUCTION_KV,
            }),
        ).toBe(PRODUCTION_KV);
    });

    it('rejects conflicting production KV sources', () => {
        expect(() =>
            resolveProductionKvNamespaceId({
                deployKvNamespaceId: FREE_TEST_KV,
                explicitProductionKvNamespaceId: PRODUCTION_KV,
            }),
        ).toThrow(FreeTestDeploySafetyError);
        expect(() =>
            resolveProductionKvNamespaceId({
                explicitProductionKvNamespaceId: PRODUCTION_KV,
                productionConfigKvNamespaceId: FREE_TEST_KV,
            }),
        ).toThrow(FreeTestDeploySafetyError);
    });

    it('fails closed for missing, local or malformed production KV confirmation', () => {
        expect(() =>
            resolveProductionKvNamespaceId({
                deployKvNamespaceId: PRODUCTION_KV,
                explicitProductionKvNamespaceId: 'local',
            }),
        ).toThrow(FreeTestDeploySafetyError);
        expect(() =>
            resolveProductionKvNamespaceId({
                explicitProductionKvNamespaceId: 'not-a-kv-id',
            }),
        ).toThrow(FreeTestDeploySafetyError);
    });

    it('collects top-level and env.* KV ids and preview ids', () => {
        const refs = collectKvNamespaceRefs({
            kv_namespaces: [{ binding: 'DATABASE', id: FREE_TEST_KV, preview_id: PRODUCTION_KV }],
            env: {
                production: {
                    kv_namespaces: [{ binding: 'DATABASE', id: PRODUCTION_KV, preview_id: FREE_TEST_KV }],
                },
            },
        });
        expect(refs.map(ref => ref.value)).toEqual([FREE_TEST_KV, PRODUCTION_KV, PRODUCTION_KV, FREE_TEST_KV]);
        expect(refs.map(ref => ref.label)).toContain('env.production.kv_namespaces[0] (DATABASE)');
    });

    it('rejects using the production KV id in the free-test or base config', () => {
        expect(() => assertNoProductionKvId(PRODUCTION_KV, PRODUCTION_KV, 'base DATABASE')).toThrow(
            FreeTestDeploySafetyError,
        );
        expect(() => assertNoProductionKvId(PRODUCTION_KV, PRODUCTION_KV, 'base DATABASE preview_id')).toThrow(
            FreeTestDeploySafetyError,
        );
        expect(() => assertNoProductionKvId(PRODUCTION_KV, FREE_TEST_KV, 'free DATABASE')).not.toThrow();
    });

    it('validates required KV ids and main path normalization', () => {
        expect(requiredKvNamespaceId(FREE_TEST_KV, 'free')).toBe(FREE_TEST_KV);
        expect(() => requiredKvNamespaceId(undefined, 'free')).toThrow(FreeTestDeploySafetyError);
        expect(() => requiredKvNamespaceId('local', 'free')).toThrow(FreeTestDeploySafetyError);
        expect(() => requiredKvNamespaceId('not-a-kv-id', 'free')).toThrow(FreeTestDeploySafetyError);
        expect(normalizeMainPath(`./${EXPECTED_FREE_TEST_MAIN}`)).toBe(EXPECTED_FREE_TEST_MAIN);
    });
});
