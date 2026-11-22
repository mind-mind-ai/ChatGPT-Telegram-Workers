export const DEFAULT_WORKSPACE_ROOT = '/workspace';

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;
export const MAX_COMMAND_LENGTH = 32_768;

export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MAX_FILE_BYTES = 8 * 1024 * 1024;

export const DEFAULT_MAX_LIST_ENTRIES = 1_000;
export const MAX_MAX_LIST_ENTRIES = 5_000;

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
export const MAX_INACTIVITY_TIMEOUT_MS = 6 * 60 * 60_000;

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
