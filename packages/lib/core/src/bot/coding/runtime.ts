import { createGitHubServiceFromEnv, type GitHubService } from '@chatgpt-telegram-workers/agent';
import { createDurableCodingSessionCoordinator } from './coordinator';
import { ENV } from '@chatgpt-telegram-workers/config';
import { CodingSessionManager } from './manager';
import { CodingSessionStore } from './session';
import { CodingSessionError, type CodingSessionCoordinator } from './types';

let manager: CodingSessionManager | null = null;
let github: GitHubService | null = null;

export function createDefaultCodingCoordinator(userId: string, chatId: string): CodingSessionCoordinator {
    return createDurableCodingSessionCoordinator(
        ENV.CODING_SESSION as Parameters<typeof createDurableCodingSessionCoordinator>[0],
        userId,
        chatId,
    );
}

export function getDefaultGitHubService(): GitHubService {
    if (!github) {
        github = createGitHubServiceFromEnv(ENV);
    }
    return github;
}

export function getDefaultCodingManager(): CodingSessionManager {
    if (!manager) {
        if (!ENV.DATABASE) {
            throw new CodingSessionError('sandbox', 'DATABASE is not configured');
        }
        manager = new CodingSessionManager({
            store: new CodingSessionStore(ENV.DATABASE),
            githubFactory: getDefaultGitHubService,
        });
    }
    return manager;
}

/** Test hook: forget cached runtime objects after changing ENV. */
export function resetCodingRuntime(): void {
    manager = null;
    github = null;
}
