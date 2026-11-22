import { SandboxAbortError, SandboxTimeoutError } from './errors';

export interface AbortScope {
    signal: AbortSignal;
    timedOut: () => boolean;
    clear: () => void;
}

export function createAbortScope(parent: AbortSignal | undefined, timeoutMs: number): AbortScope {
    const controller = new AbortController();
    let timedOut = false;

    const abortFromParent = () => controller.abort(parent?.reason);
    if (parent) {
        if (parent.aborted) {
            controller.abort(parent.reason);
        } else {
            parent.addEventListener('abort', abortFromParent, { once: true });
        }
    }

    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  controller.abort(new SandboxTimeoutError(`Sandbox operation timed out after ${timeoutMs} ms`));
              }, timeoutMs)
            : undefined;

    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        clear: () => {
            if (timer) {
                clearTimeout(timer);
            }
            parent?.removeEventListener('abort', abortFromParent);
        },
    };
}

export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(
            signal.reason instanceof Error
                ? signal.reason
                : new SandboxAbortError('Sandbox operation aborted', { cause: signal.reason }),
        );
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new SandboxAbortError('Sandbox operation aborted', { cause: signal.reason }),
            );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}
