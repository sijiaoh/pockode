import type { JSONRPCRequester } from "json-rpc-2.0";
import type { FileBlock } from "../../types/content";
import type {
	HistorySeq,
	HtmlAction,
	HtmlActionParams,
	InterruptParams,
	MessageAttachmentParams,
	MessageParams,
	MessageResult,
	PermissionResponseParams,
	PockodeCommandInvocation,
	QuestionAnswerParams,
} from "../../types/message";
import { parseFileBlocks } from "../contentBlocks";
import {
	normalizeCommand,
	normalizeHtmlAction,
	readHistorySeq,
} from "../messageReducer";

/** What the server said about a message it accepted; see `MessageResult`. */
export interface SentMessage {
	seq?: HistorySeq;
	/** See `UserMessage.messageId`. */
	messageId?: string;
	/**
	 * Present when the server wrote the text the agent was sent rather than
	 * taking it as typed: the prompt a Pockode command expanded to, with the
	 * command as the server parsed it, or the body written from a message's
	 * answers.
	 */
	expanded?: { content: string; command?: PockodeCommandInvocation };
	/** The files the message carried, as the server described them. */
	attachments?: FileBlock[];
}

/** What a page sent, as the app sends it on (`chat.html_action`). */
export interface HtmlActionInput {
	/** The card's id; the app's, never the page's. */
	page: string;
	action: string;
	/** Any JSON; omitted means `{}`. */
	data?: unknown;
}

/** What the server said about a page's send it accepted. */
export interface SentHtmlAction {
	seq?: HistorySeq;
	messageId?: string;
	/** The action as the agent reads it: the record's `content`. */
	content?: string;
	/** The action as its record carries it, `data` normalized. */
	htmlAction?: HtmlAction;
}

export interface ChatActions {
	/**
	 * Resolves with the seq the server gave the message, so the caller can name
	 * that record — absent when it has no address to give (see `MessageResult`),
	 * which is not a failure.
	 */
	sendMessage: (
		sessionId: string,
		content: string,
		/**
		 * The posted questions this message answers. The server validates the
		 * whole set against the session's live list before delivering anything
		 * and refuses the message outright when any entry is no longer pending —
		 * see `MessageParams.answering`.
		 */
		answering?: QuestionAnswerParams[],
		/**
		 * Files uploaded to the session beforehand (`uploadChatAttachment`).
		 * Refused beside `answering`.
		 */
		attachments?: MessageAttachmentParams[],
	) => Promise<SentMessage>;
	/**
	 * Sends what a page sent (`chat.html_action`, docs/tool-call-ui.md § The
	 * action message). Refusals are `InvalidParams` in the server's words; one
	 * while the turn awaits a permission answer carries `data.reason:
	 * "awaiting_permission"` (`isAwaitingPermissionRejection`).
	 */
	sendHtmlAction: (
		sessionId: string,
		action: HtmlActionInput,
	) => Promise<SentHtmlAction>;
	interrupt: (sessionId: string) => Promise<void>;
	permissionResponse: (params: PermissionResponseParams) => Promise<void>;
}

/**
 * @param getAgentStartClient Requester for `chat.message` alone, which unlike
 * every other call here may have to wait out an agent CLI cold start. See
 * AGENT_START_RPC_TIMEOUT_MS in wsStore.
 */
export function createChatActions(
	getClient: () => JSONRPCRequester<void> | null,
	getAgentStartClient: () => JSONRPCRequester<void> | null,
): ChatActions {
	const requireClient = (
		get: () => JSONRPCRequester<void> | null = getClient,
	): JSONRPCRequester<void> => {
		const client = get();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		sendMessage: async (
			sessionId: string,
			content: string,
			answering?: QuestionAnswerParams[],
			attachments?: MessageAttachmentParams[],
		): Promise<SentMessage> => {
			const result = (await requireClient(getAgentStartClient).request(
				"chat.message",
				{
					session_id: sessionId,
					content,
					...(answering && answering.length > 0 ? { answering } : {}),
					...(attachments && attachments.length > 0 ? { attachments } : {}),
				} as MessageParams,
			)) as MessageResult | undefined;
			// Decoded by the same reader as a seq arriving on a notification, because
			// it is the same field with the same rule: a server too old to send one
			// answers with an empty object, and the missing field must stay absent
			// rather than become a seq of 0, which names no record.
			const seq = readHistorySeq(result);
			const command = normalizeCommand(result?.command);
			const files = parseFileBlocks(result?.attachments);
			return {
				...(seq !== undefined ? { seq } : {}),
				...(result?.message_id ? { messageId: result.message_id } : {}),
				...(files ? { attachments: files } : {}),
				...(typeof result?.content === "string"
					? {
							expanded: {
								content: result.content,
								...(command ? { command } : {}),
							},
						}
					: {}),
			};
		},

		sendHtmlAction: async (
			sessionId: string,
			{ page, action, data }: HtmlActionInput,
		): Promise<SentHtmlAction> => {
			// Through the agent-start requester for the reason `chat.message` is:
			// a page's send is a message, and may be what starts the agent.
			const result = (await requireClient(getAgentStartClient).request(
				"chat.html_action",
				{
					session_id: sessionId,
					page,
					action,
					...(data !== undefined ? { data } : {}),
				} satisfies HtmlActionParams,
			)) as MessageResult | undefined;
			const seq = readHistorySeq(result);
			const htmlAction = normalizeHtmlAction(result?.html_action);
			return {
				...(seq !== undefined ? { seq } : {}),
				...(result?.message_id ? { messageId: result.message_id } : {}),
				...(typeof result?.content === "string"
					? { content: result.content }
					: {}),
				...(htmlAction ? { htmlAction } : {}),
			};
		},

		interrupt: async (sessionId: string): Promise<void> => {
			await requireClient().request("chat.interrupt", {
				session_id: sessionId,
			} as InterruptParams);
		},

		permissionResponse: async (
			params: PermissionResponseParams,
		): Promise<void> => {
			await requireClient().request("chat.permission_response", params);
		},
	};
}
