import type { GitHubService } from '@chatgpt-telegram-workers/agent';
import type * as Telegram from 'telegram-bot-api-types';
import type { WorkerContext } from '../context';
import type { CommandHandler } from './types';
import { createDefaultCodingCoordinator, getDefaultGitHubService } from '../coding/runtime';
import { createMessageReply, type CodingReply } from '../coding/telegram';
import {
    CodingSessionError,
    codingApprovalCallbackData,
    codingErrorMessage,
    type CodingCoordinatorFactory,
    type CodingDurableSession,
    type CodingJobStatus,
} from '../coding/types';

export interface CodingCoordinatorDependencies {
    coordinator: CodingCoordinatorFactory;
    reply: (token: string, message: Telegram.Message) => CodingReply;
}

export interface CodingCommandDependencies extends CodingCoordinatorDependencies {
    github: GitHubService;
}

function defaultCoordinatorDependencies(): CodingCoordinatorDependencies {
    return {
        coordinator: createDefaultCodingCoordinator,
        reply: createMessageReply,
    };
}

function defaultDependencies(): CodingCommandDependencies {
    return {
        ...defaultCoordinatorDependencies(),
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

export function codingStatusLabel(status: CodingJobStatus): string {
    switch (status) {
        case 'queued':
            return 'queued';
        case 'running':
            return 'running';
        case 'awaiting_input':
            return 'idle (awaiting input)';
        case 'cancelling':
            return 'cancelling';
        case 'cancelled':
            return 'cancelled';
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
    }
}

function approvalKeyboard(session: CodingDurableSession): Telegram.InlineKeyboardMarkup | null {
    const approval = session.approval;
    if (!approval || !['pending', 'approved', 'applying', 'failed'].includes(approval.status)) {
        return null;
    }
    const button = (text: string, action: 'review' | 'approve' | 'reject') => ({
        text,
        callback_data: codingApprovalCallbackData(action, approval.id, approval.nonce),
    });
    return {
        inline_keyboard: [
            [button('Review changes', 'review')],
            [button('Approve and save to GitHub', 'approve'), button('Reject changes', 'reject')],
        ],
    };
}

function formatStatus(session: CodingDurableSession): string {
    const lines = [
        `Repository: ${session.repository}`,
        `Session: ${session.sessionId}`,
        `Status: ${codingStatusLabel(session.status)}`,
    ];
    if (session.job) {
        lines.push(`Job: ${session.job.kind} / ${codingStatusLabel(session.job.status)}`);
        if (session.job.progress) {
            lines.push(`Progress: ${session.job.progress}`);
        }
        if (session.job.error) {
            lines.push(`Error: ${session.job.error}`);
        }
    }
    if (session.cancellationRequested) {
        lines.push('Cancellation: requested');
    }
    if (session.approval) {
        lines.push(`Approval: ${session.approval.status}`);
        lines.push(`Approval expires: ${new Date(session.approval.expiresAt).toISOString()}`);
        if (session.approval.branch) {
            lines.push(`Approved branch: ${session.approval.branch}`);
        }
        if (session.approval.commitSha) {
            lines.push(`Approved commit: ${session.approval.commitSha}`);
        }
        if (session.approval.error) {
            lines.push(`Approval error: ${session.approval.error}`);
        }
    }
    return lines.join('\n');
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
            const coordinator = deps.coordinator(identity.userId, identity.chatId);
            const existing = await coordinator.getState(identity.userId, identity.chatId);
            if (existing && ['queued', 'running', 'awaiting_input', 'cancelling'].includes(existing.status)) {
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

    constructor(private readonly deps?: CodingCoordinatorDependencies) {}

    handle = async (message: Telegram.Message, _subcommand: string, context: WorkerContext): Promise<Response> => {
        const reply = (this.deps?.reply ?? createMessageReply)(context.SHARE_CONTEXT.botToken, message);
        const identity = privateIdentity(message);
        if (!identity) {
            return reply.sendText('Coding sessions are only available in private chats.');
        }
        try {
            const deps = this.deps ?? defaultCoordinatorDependencies();
            const coordinator = deps.coordinator(identity.userId, identity.chatId);
            const session = await coordinator.getState(identity.userId, identity.chatId);
            if (!session) {
                return reply.sendText('No active coding session. Use /code to start one.');
            }
            const keyboard = approvalKeyboard(session);
            return keyboard
                ? reply.sendKeyboard(formatStatus(session), keyboard)
                : reply.sendText(formatStatus(session));
        } catch (error) {
            return reply.sendText(`Could not read coding status: ${codingErrorMessage(error)}`);
        }
    };
}

export class CodeStopCommandHandler implements CommandHandler {
    command = '/code_stop';
    scopes = ['all_private_chats'];

    constructor(private readonly deps?: CodingCoordinatorDependencies) {}

    handle = async (message: Telegram.Message, _subcommand: string, context: WorkerContext): Promise<Response> => {
        const reply = (this.deps?.reply ?? createMessageReply)(context.SHARE_CONTEXT.botToken, message);
        const identity = privateIdentity(message);
        if (!identity) {
            return reply.sendText('Coding sessions are only available in private chats.');
        }
        try {
            const deps = this.deps ?? defaultCoordinatorDependencies();
            const coordinator = deps.coordinator(identity.userId, identity.chatId);
            const stopped = await coordinator.stopSession(identity.userId, identity.chatId);
            if (!stopped) {
                return reply.sendText('No active coding session.');
            }
            if (stopped.status === 'cancelling') {
                return reply.sendText(
                    'Cancellation requested. The job is still stopping; use /code_status to confirm it has stopped.',
                );
            }
            if (stopped.status === 'cancelled') {
                return reply.sendText('Coding session cancelled.');
            }
            if (stopped.status === 'failed') {
                return reply.sendText('The coding session had already failed.');
            }
            return reply.sendText('Coding session stopped.');
        } catch (error) {
            return reply.sendText(`Could not stop coding session: ${codingErrorMessage(error)}`);
        }
    };
}
