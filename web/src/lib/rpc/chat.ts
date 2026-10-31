import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	CanvasAction,
	CanvasActionParams,
	CanvasSize,
} from "../../types/canvas";
import type { FileBlock } from "../../types/content";
import type {
	HistorySeq,
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
	normalizeCanvasAction,
	normalizeCommand,
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

/**
 * A canvas action as the app sends it. `revision` is the one the frame was
 * showing — the app's record, never the page's (docs/canvas-ui.md §8.2).
 */
export interface CanvasActionInput {
	action: string;
	/** Any JSON; omitted means `{}`. */
	data?: unknown;
	revision: number;
}

/** What the server said about a canvas action it accepted. */
export interface SentCanvasAction {
	seq?: HistorySeq;
	messageId?: string;
	/** The action as the agent reads it: the record's `content`. */
	content?: string;
	/** The action as its record carries it, `data` normalized. */
	canvasAction?: CanvasAction;
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
		/** The device's canvas size; the server ignores it outside a canvas session. */
		canvasSize?: CanvasSize,
	) => Promise<SentMessage>;
	/**
	 * Sends what the user did on a canvas page (`chat.canvas_action`, see
	 * docs/canvas-ui.md §6.4). Refusals are `InvalidParams` in the server's
	 * words; one while the turn awaits a permission answer among them.
	 */
	sendCanvasAction: (
		sessionId: string,
		action: CanvasActionInput,
		canvasSize?: CanvasSize,
	) => Promise<SentCanvasAction>;
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
			canvasSize?: CanvasSize,
		): Promise<SentMessage> => {
			const result = (await requireClient(getAgentStartClient).request(
				"chat.message",
				{
					session_id: sessionId,
					content,
					...(answering && answering.length > 0 ? { answering } : {}),
					...(attachments && attachments.length > 0 ? { attachments } : {}),
					...(canvasSize ? { canvas_size: canvasSize } : {}),
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

		sendCanvasAction: async (
			sessionId: string,
			{ action, data, revision }: CanvasActionInput,
			canvasSize?: CanvasSize,
		): Promise<SentCanvasAction> => {
			// Through the agent-start requester for the reason `chat.message` is:
			// an action is a message, and may be what starts the agent.
			const result = (await requireClient(getAgentStartClient).request(
				"chat.canvas_action",
				{
					session_id: sessionId,
					action,
					...(data !== undefined ? { data } : {}),
					revision,
					...(canvasSize ? { canvas_size: canvasSize } : {}),
				} satisfies CanvasActionParams,
			)) as MessageResult | undefined;
			const seq = readHistorySeq(result);
			const canvasAction = normalizeCanvasAction(result?.canvas_action);
			return {
				...(seq !== undefined ? { seq } : {}),
				...(result?.message_id ? { messageId: result.message_id } : {}),
				...(typeof result?.content === "string"
					? { content: result.content }
					: {}),
				...(canvasAction ? { canvasAction } : {}),
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
