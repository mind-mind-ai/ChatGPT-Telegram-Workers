export type SandboxErrorCode =
    | 'invalid-workspace'
    | 'not-initialized'
    | 'invalid-path'
    | 'not-found'
    | 'not-directory'
    | 'already-exists'
    | 'limit'
    | 'timeout'
    | 'aborted'
    | 'exec'
    | 'file'
    | 'snapshot'
    | 'destroyed'
    | 'unsupported'
    | 'protocol'
    | 'internal';

export class SandboxError extends Error {
    readonly name: string = 'SandboxError';

    constructor(
        public readonly code: SandboxErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
    }
}

export class SandboxTimeoutError extends SandboxError {
    readonly name = 'SandboxTimeoutError';

    constructor(message = 'Sandbox operation timed out', options?: ErrorOptions) {
        super('timeout', message, options);
    }
}

export class SandboxAbortError extends SandboxError {
    readonly name = 'SandboxAbortError';

    constructor(message = 'Sandbox operation aborted', options?: ErrorOptions) {
        super('aborted', message, options);
    }
}

export class SandboxLimitError extends SandboxError {
    readonly name = 'SandboxLimitError';

    constructor(message: string, options?: ErrorOptions) {
        super('limit', message, options);
    }
}

export class SandboxPathError extends SandboxError {
    readonly name = 'SandboxPathError';

    constructor(message: string, options?: ErrorOptions) {
        super('invalid-path', message, options);
    }
}

export class SandboxDisposedError extends SandboxError {
    readonly name = 'SandboxDisposedError';

    constructor(message = 'Sandbox has been destroyed') {
        super('destroyed', message);
    }
}

export class SandboxFileError extends SandboxError {
    readonly name = 'SandboxFileError';

    constructor(
        public readonly operation: string,
        public readonly path: string,
        message: string,
        public readonly errno?: string,
        options?: ErrorOptions,
    ) {
        super('file', message, options);
    }
}

export class SandboxExecError extends SandboxError {
    readonly name = 'SandboxExecError';

    constructor(message: string, options?: ErrorOptions) {
        super('exec', message, options);
    }
}
