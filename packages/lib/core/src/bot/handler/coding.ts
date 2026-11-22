import type { GitHubService } from '@chatgpt-telegram-workers/agent';
import type * as Telegram from 'telegram-bot-api-types';
import type { WorkerContext } from '../context';
import type { MessageHandler, UpdateHandler } from './types';
import { createDefaultCodingCoordinator, getDefaultGitHubService } from '../coding/runtime';
import { createMessageReply, createReplyForUpdate, type CodingReply } from '../coding/telegram';
import {
    CodingSessionError,
    codingErrorMessage,
    parseCodingApprovalCallbackData,
    type CodingApprovalResult,
    type CodingChangeSet,
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

async function sendReview(reply: CodingReply, changeSet: CodingChangeSet): Promise<void> {
    const caption = [
        'Proposed changes',
        changeSet.summary,
        `Repository: ${changeSet.repository}`,
        `Base: ${changeSet.baseRef} @ ${changeSet.baseCommitSha.slice(0, 12)}`,
    ].join('\n');
    if (changeSet.diff.length > 3_500) {
        await reply.sendDocument(
            `changes-${changeSet.diffHash.slice(0, 12)}.diff`,
            new TextEncoder().encode(changeSet.diff),
            caption,
        );
        return;
    }
    await reply.sendText(`${caption}\n\n${changeSet.diff}`);
}

function formatApprovalStatus(approval: CodingApprovalResult['approval']): string {
    switch (approval.status) {
        case 'completed':
            return `Approved changes were already written to GitHub.\nBranch: ${approval.branch ?? 'unknown'}\nCommit: ${approval.commitSha ?? 'unknown'}`;
        case 'approved':
        case 'applying':
            return 'The approved changes are being written to GitHub.';
        case 'failed':
            return `GitHub write failed: ${approval.error ?? 'unknown error'}\nThe proposed changes are preserved in this session.`;
        case 'rejected':
            return 'These changes were rejected. Nothing was written to GitHub.';
        case 'expired':
            return 'This approval expired. Nothing was written to GitHub.';
        case 'stale':
            return 'These changes no longer match the sandbox. Nothing was written to GitHub.';
        default:
            return 'No reviewable changes are available for this approval.';
    }
}

function formatApprovalResult(result: CodingApprovalResult): string {
    if (result.approval.status === 'completed') {
        return [
            'Approved changes were written to GitHub.',
            `Branch: ${result.branch ?? result.approval.branch ?? 'unknown'}`,
            `Commit: ${result.commitSha ?? result.approval.commitSha ?? 'unknown'}`,
            'Nothing was merged, deployed or written to the default branch.',
        ].join('\n');
    }
    if (result.approval.status === 'failed') {
        return `${formatApprovalStatus(result.approval)}\nThe change set is still stored for review.`;
    }
    return formatApprovalStatus(result.approval);
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
        if (`${userId}` !== `${chatId}`) {
            await reply.answerCallback('This coding action does not belong to you');
            return ok();
        }
        const identity = { userId: `${userId}`, chatId: `${chatId}` };
        const approvalCallback = parseCodingApprovalCallbackData(callback.data);
        if (approvalCallback) {
            try {
                const deps = this.deps ?? defaultCallbackDependencies();
                const coordinator = deps.coordinator(identity.userId, identity.chatId);
                const request = {
                    userId: identity.userId,
                    chatId: identity.chatId,
                    approvalId: approvalCallback.approvalId,
                    nonce: approvalCallback.nonce,
                };
                if (approvalCallback.action === 'review') {
                    await reply.answerCallback('Opening approved changes');
                    const review = await coordinator.reviewApproval(request);
                    if (review.changeSet) {
                        await sendReview(reply, review.changeSet);
                    } else {
                        await reply.sendText(formatApprovalStatus(review.approval));
                    }
                    return ok();
                }
                await reply.answerCallback(
                    approvalCallback.action === 'approve' ? 'Approving changes' : 'Rejecting changes',
                );
                const result =
                    approvalCallback.action === 'approve'
                        ? await coordinator.approveChanges(request)
                        : await coordinator.rejectChanges(request);
                await reply.sendText(formatApprovalResult(result));
            } catch (error) {
                await reply.answerCallback('Approval failed');
                if (error instanceof CodingSessionError) {
                    await reply.sendText(`Approval failed: ${error.message}`);
                } else {
                    await reply.sendText(`Approval failed: ${codingErrorMessage(error)}`);
                }
            }
            return ok();
        }
        const match = /^code:repo:(\d+)$/.exec(callback.data);
        if (!match) {
            await reply.answerCallback('Unknown coding action');
            return ok();
        }
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
