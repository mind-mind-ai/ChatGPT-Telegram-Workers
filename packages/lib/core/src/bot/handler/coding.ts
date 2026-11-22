import type { GitHubService } from '@chatgpt-telegram-workers/agent';
import type * as Telegram from 'telegram-bot-api-types';
import type { WorkerContext } from '../context';
import type { MessageHandler, UpdateHandler } from './types';
import { createDefaultCodingCoordinator, getDefaultGitHubService } from '../coding/runtime';
import { createMessageReply, createReplyForUpdate, type CodingReply } from '../coding/telegram';
import {
    CodingSessionError,
    codingErrorMessage,
    type CodingCoordinatorFactory,
    type CodingDurableSession,
} from '../coding/types';

export interface CodingCallbackDependencies {
    coordinator: CodingCoordinatorFactory;
    github: GitHubService;
    reply: (token: string, update: Telegram.Update) => CodingReply;
}

export interface CodingMessageDependencies {
    coordinator: CodingCoordinatorFactory;
    reply: (token: string, message: Telegram.Message) => CodingReply;
}

function defaultCallbackDependencies(): CodingCallbackDependencies {
    return {
        coordinator: createDefaultCodingCoordinator,
        github: getDefaultGitHubService(),
        reply: createReplyForUpdate,
    };
}

function defaultMessageDependencies(): CodingMessageDependencies {
    return {
        coordinator: createDefaultCodingCoordinator,
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

function isActive(session: CodingDurableSession): boolean {
    return ['queued', 'running', 'awaiting_input', 'cancelling'].includes(session.status);
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
            const coordinator = deps.coordinator(identity.userId, identity.chatId);
            const existing = await coordinator.getState(identity.userId, identity.chatId);
            if (existing && isActive(existing)) {
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
            await coordinator.createSession({
                userId: identity.userId,
                chatId: identity.chatId,
                repository: repository.fullName,
                telegram: { chatId },
            });
            await reply.sendText(
                `Repository loading in the background for ${repository.fullName}. I will send progress here.`,
            );
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
        const coordinator = deps.coordinator(identity.userId, identity.chatId);
        let session: CodingDurableSession | null;
        try {
            session = await coordinator.getState(identity.userId, identity.chatId);
        } catch {
            // Do not turn an unavailable coding backend into a normal chat failure.
            return null;
        }
        if (!session) {
            return null;
        }
        const reply = deps.reply(context.SHARE_CONTEXT.botToken, message);

        if (message.photo?.length || message.document) {
            return reply.sendText('Coding sessions accept text instructions only.');
        }
        if (session.status === 'queued') {
            return reply.sendText('The coding job is queued. I will send progress when it starts.');
        }
        if (session.status === 'running') {
            return reply.sendText('The coding agent is already working. Wait for the result or use /code_stop.');
        }
        if (session.status === 'cancelling') {
            return reply.sendText('The coding job is still stopping. Use /code_status to confirm it has stopped.');
        }
        if (session.status === 'failed' || session.status === 'cancelled') {
            return reply.sendText('This coding session has ended. Use /code to start a new one.');
        }

        const instruction = (message.text ?? message.caption ?? '').trim();
        if (!instruction) {
            return reply.sendText('Send a text instruction for the coding agent.');
        }

        try {
            await coordinator.enqueueInstruction({
                userId: identity.userId,
                chatId: identity.chatId,
                instruction,
                telegram: { chatId: Number(identity.chatId) },
            });
            return reply.sendText(`Queued the coding job for ${session.repository}. I will send progress here.`);
        } catch (error) {
            if (error instanceof CodingSessionError) {
                if (error.code === 'expired' || error.code === 'not-found') {
                    return reply.sendText('Coding session expired. Use /code to start a new one.');
                }
                return reply.sendText(`Could not queue coding job: ${error.message}`);
            }
            return reply.sendText(`Could not queue coding job: ${codingErrorMessage(error)}`);
        }
    };
}
