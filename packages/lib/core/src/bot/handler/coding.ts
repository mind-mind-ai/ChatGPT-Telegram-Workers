import type { GitHubService } from '@chatgpt-telegram-workers/agent';
import type * as Telegram from 'telegram-bot-api-types';
import type { WorkerContext } from '../context';
import type { MessageHandler, UpdateHandler } from './types';
import type { CodingSessionManager } from '../coding/manager';
import { getDefaultCodingManager, getDefaultGitHubService } from '../coding/runtime';
import { createMessageReply, createReplyForUpdate, sendLongText, type CodingReply } from '../coding/telegram';
import { CodingSessionError, codingErrorMessage } from '../coding/types';

export interface CodingCallbackDependencies {
    manager: CodingSessionManager;
    github: GitHubService;
    reply: (token: string, update: Telegram.Update) => CodingReply;
}

export interface CodingMessageDependencies {
    manager: CodingSessionManager;
    reply: (token: string, message: Telegram.Message) => CodingReply;
}

function defaultCallbackDependencies(): CodingCallbackDependencies {
    return {
        manager: getDefaultCodingManager(),
        github: getDefaultGitHubService(),
        reply: createReplyForUpdate,
    };
}

function defaultMessageDependencies(): CodingMessageDependencies {
    return {
        manager: getDefaultCodingManager(),
        reply: createMessageReply,
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

function ok(): Response {
    return new Response('OK', { status: 200 });
}

export class CodingCallbackHandler implements UpdateHandler {
    constructor(private readonly deps?: CodingCallbackDependencies) {}

    handle = async (update: Telegram.Update, context: WorkerContext): Promise<Response | null> => {
        const callback = update.callback_query;
        if (!callback || !callback.data?.startsWith('code:')) {
            return null;
        }
        const message = callback.message;
        const userId = callback.from?.id;
        const chatId = message?.chat.id;
        if (!message || !userId || !chatId) {
            return ok();
        }
        const reply = (this.deps?.reply ?? createReplyForUpdate)(context.SHARE_CONTEXT.botToken, update);
        if (message.chat.type !== 'private') {
            await reply.answerCallback('Coding sessions are only available in private chats');
            return ok();
        }
        const match = /^code:repo:(\d+)$/.exec(callback.data);
        if (!match) {
            await reply.answerCallback('Unknown coding action');
            return ok();
        }
        if (`${userId}` !== `${chatId}`) {
            await reply.answerCallback('This repository selection does not belong to you');
            return ok();
        }
        const identity = { userId: `${userId}`, chatId: `${chatId}` };

        try {
            const deps = this.deps ?? defaultCallbackDependencies();
            const existing = await deps.manager.getSession(identity.userId, identity.chatId);
            if (existing) {
                await reply.answerCallback('A coding session is already active');
                await reply.sendText('A coding session is already active. Use /code_status or /code_stop first.');
                return ok();
            }
            const repositories = await deps.github.listAuthorizedRepositories({
                userId: identity.userId,
                chatId: identity.chatId,
            });
            const index = Number.parseInt(match[1], 10);
            const repository = repositories[index];
            if (!repository) {
                await reply.answerCallback('Repository list changed; send /code again');
                await reply.sendText('That repository is no longer available. Send /code to refresh the list.');
                return ok();
            }

            await reply.answerCallback('Starting coding session');
            await reply.sendText(`Starting coding session for ${repository.fullName}...`);
            await deps.manager.startSession(identity.userId, identity.chatId, repository.fullName);
            await reply.sendText('Repository loaded. What would you like me to do?');
        } catch (error) {
            await reply.answerCallback('Could not start coding session');
            if (error instanceof CodingSessionError) {
                await reply.sendText(`Could not start coding session: ${error.message}`);
            } else {
                await reply.sendText(`Could not start coding session: ${codingErrorMessage(error)}`);
            }
        }
        return ok();
    };
}

export class CodingMessageHandler implements MessageHandler {
    constructor(private readonly deps?: CodingMessageDependencies) {}

    handle = async (message: Telegram.Message, context: WorkerContext): Promise<Response | null> => {
        const identity = privateIdentity(message);
        if (!identity) {
            return null;
        }
        const deps = this.deps ?? defaultMessageDependencies();
        const session = await deps.manager.getSession(identity.userId, identity.chatId);
        if (!session) {
            return null;
        }
        const reply = deps.reply(context.SHARE_CONTEXT.botToken, message);

        if (message.photo?.length || message.document) {
            return reply.sendText('Coding sessions accept text instructions only.');
        }
        if (session.status === 'running') {
            return reply.sendText('The coding agent is already working. Wait for the result or use /code_stop.');
        }
        if (session.status === 'initializing') {
            return reply.sendText('The coding session is still starting. Please wait a moment.');
        }

        const instruction = (message.text ?? message.caption ?? '').trim();
        if (!instruction) {
            return reply.sendText('Send a text instruction for the coding agent.');
        }

        await reply.sendText(`Working on ${session.repository}...`);
        try {
            const result = await deps.manager.runInstruction(session, instruction);
            return sendLongText(reply, result.text || 'The coding agent returned an empty response.');
        } catch (error) {
            if (error instanceof CodingSessionError) {
                if (error.code === 'cancelled') {
                    const current = await deps.manager.getSession(identity.userId, identity.chatId);
                    if (!current) {
                        return ok();
                    }
                }
                if (error.code === 'expired' || error.code === 'not-found') {
                    return reply.sendText('Coding session expired. Use /code to start a new one.');
                }
                return reply.sendText(`Coding session failed: ${error.message}`);
            }
            return reply.sendText(`Coding session failed: ${codingErrorMessage(error)}`);
        }
    };
}
