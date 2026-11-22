export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(numeric)));
}
