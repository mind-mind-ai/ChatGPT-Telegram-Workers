/** Shared abort error that preserves the standard `name` value. */
export function createAbortError(message = 'Agent run aborted', cause?: unknown): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    if (cause !== undefined) {
        (error as Error & { cause?: unknown }).cause = cause;
    }
    return error;
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

export class AgentTimeoutError extends Error {
    readonly name = 'TimeoutError';

    constructor(message = 'Agent run timed out', cause?: unknown) {
        super(message);
        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}

export class ToolTimeoutError extends Error {
    readonly name = 'TimeoutError';

    constructor(message = 'Tool execution timed out', cause?: unknown) {
        super(message);
        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}

export function abortReason(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error) {
        return reason;
    }
    if (reason !== undefined) {
        return createAbortError(String(reason));
    }
    return createAbortError();
}

/** Waits for a promise to settle, or rejects as soon as the signal aborts. */
export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(abortReason(signal));
    }
    return new Promise<T>((resolve, reject) => {
        function onAbort() {
            cleanup();
            reject(abortReason(signal));
        }
        function cleanup() {
            signal.removeEventListener('abort', onAbort);
        }
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => {
                cleanup();
                resolve(value);
            },
            error => {
                cleanup();
                reject(error);
            },
        );
    });
}
