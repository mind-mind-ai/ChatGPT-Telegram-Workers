import type { GitHubService } from '@chatgpt-telegram-workers/agent';
import type * as Telegram from 'telegram-bot-api-types';
import type { WorkerContext } from '../context';
import type { CommandHandler } from './types';
import { getDefaultCodingManager, getDefaultGitHubService } from '../coding/runtime';
import type { CodingSessionManager } from '../coding/manager';
import { createMessageReply, type CodingReply } from '../coding/telegram';
import { CodingSessionError, codingErrorMessage } from '../coding/types';

export interface CodingManagerDependencies {
    manager: CodingSessionManager;
    reply: (token: string, message: Telegram.Message) => CodingReply;
}

export interface CodingCommandDependencies extends CodingManagerDependencies {
    github: GitHubService;
}

function defaultManagerDependencies(): CodingManagerDependencies {
    return {
        manager: getDefaultCodingManager(),
        reply: createMessageReply,
    };
}

function defaultDependencies(): CodingCommandDependencies {
    return {
        ...defaultManagerDependencies(),
        github: getDefaultGitHubService(),
    };
}

function privateIdentity(message: Telegram.Message): { userId: string; chatId: string } | null {
    const userId = message.from?.id;
    const chatId = message.chat.id;
    if (message.chat.type !== 'private' || !userId || !chatId) {
        return null;
    }
    return { userId: `${userId}`, chatId: `${chatId}` };
}

export class CodeCommandHandler implements CommandHandler {
    command = '/code';
    scopes = ['all_private_chats'];

    constructor(private readonly deps?: CodingCommandDependencies) {}

    handle = async (message: Telegram.Message, _subcommand: string, context: WorkerContext): Promise<Response> => {
        const reply = (this.deps?.reply ?? createMessageReply)(context.SHARE_CONTEXT.botToken, message);
        const identity = privateIdentity(message);
        if (!identity) {
            return reply.sendText('Coding sessions are only available in private chats.');
        }
        try {
            const deps = this.deps ?? defaultDependencies();
            const existing = await deps.manager.getSession(identity.userId, identity.chatId);
            if (existing) {
                return reply.sendText('A coding session is already active. Use /code_status or /code_stop first.');
            }
            const repositories = await deps.github.listAuthorizedRepositories({
                userId: identity.userId,
                chatId: identity.chatId,
            });
            if (repositories.length === 0) {
                return reply.sendText('No GitHub repositories are authorized for your account.');
            }
            const keyboard: Telegram.InlineKeyboardMarkup = {
                inline_keyboard: repositories.map((repository, index) => [
                    {
                        text: repository.fullName,
                        callback_data: `code:repo:${index}`,
                    },
                ]),
            };
            return reply.sendKeyboard('Select a repository to work on.', keyboard);
        } catch (error) {
            if (error instanceof CodingSessionError) {
                return reply.sendText(error.message);
            }
            return reply.sendText(`Could not list repositories: ${codingErrorMessage(error)}`);
        }
    };
}

export class CodeStatusCommandHandler implements CommandHandler {
    command = '/code_status';
    scopes = ['all_private_chats'];

    constructor(private readonly deps?: CodingManagerDependencies) {}

    handle = async (message: Telegram.Message, _subcommand: string, context: WorkerContext): Promise<Response> => {
        const reply = (this.deps?.reply ?? createMessageReply)(context.SHARE_CONTEXT.botToken, message);
        const identity = privateIdentity(message);
        if (!identity) {
            return reply.sendText('Coding sessions are only available in private chats.');
        }
        try {
            const deps = this.deps ?? defaultManagerDependencies();
            const session = await deps.manager.getSession(identity.userId, identity.chatId);
            if (!session) {
                return reply.sendText('No active coding session. Use /code to start one.');
            }
            return reply.sendText(
                [
                    `Repository: ${session.repository}`,
                    `Status: ${deps.manager.statusLabel(session)}`,
                    `Session: ${session.sessionId}`,
                ].join('\n'),
            );
        } catch (error) {
            return reply.sendText(`Could not read coding status: ${codingErrorMessage(error)}`);
        }
    };
}

export class CodeStopCommandHandler implements CommandHandler {
    command = '/code_stop';
    scopes = ['all_private_chats'];

    constructor(private readonly deps?: CodingManagerDependencies) {}

    handle = async (message: Telegram.Message, _subcommand: string, context: WorkerContext): Promise<Response> => {
        const reply = (this.deps?.reply ?? createMessageReply)(context.SHARE_CONTEXT.botToken, message);
        const identity = privateIdentity(message);
        if (!identity) {
            return reply.sendText('Coding sessions are only available in private chats.');
        }
        try {
            const deps = this.deps ?? defaultManagerDependencies();
            const stopped = await deps.manager.stopSession(identity.userId, identity.chatId);
            return reply.sendText(stopped ? 'Coding session stopped.' : 'No active coding session.');
        } catch (error) {
            return reply.sendText(`Could not stop coding session: ${codingErrorMessage(error)}`);
        }
    };
}
