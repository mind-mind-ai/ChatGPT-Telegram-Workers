/**
 * Commands that can enter the coding workflow. Keep this list shared with the
 * command parser and the free-test ingress guard so they cannot drift.
 */
const CODING_COMMAND_PATTERN = /^\s*\/(?:code|code_status|code_stop)(?:@[A-Za-z0-9_]+)?(?:\s|$)/;

export function isCodingCommandText(value: unknown): boolean {
    return typeof value === 'string' && CODING_COMMAND_PATTERN.test(value);
}
