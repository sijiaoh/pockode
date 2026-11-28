import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	HtmlActionParams,
	InterruptParams,
	MessageAttachmentParams,
	MessageParams,
	PermissionResponseParams,
	QuestionAnswerParams,
} from "../../types/message";

/** What a page sent, as the app sends it on (`chat.html_action`). */
export interface HtmlActionInput {
	/** The card's id; the app's, never the page's. */
	page: string;
	action: string;
	/** Any JSON; omitted means `{}`. */
	data?: unknown;
}

export interface ChatActions {
	/**
	 * Resolves once the server has the message. The reply says nothing more:
	 * the message's record arrives on the chat subscription like any other,
	 * under `messageId` — the id this client minted for it, which is also what
	 * makes sending it again safe (`MessageParams.message_id`).
	 */
	sendMessage: (
		sessionId: string,
		messageId: string,
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
	) => Promise<void>;
	/**
	 * Sends what a page sent (`chat.html_action`, docs/tool-call-ui.md § The
	 * action message). Refusals are `InvalidParams` in the server's words; one
	 * while the turn awaits a permission answer carries `data.reason:
	 * "awaiting_permission"` (`isAwaitingPermissionRejection`).
	 */
	sendHtmlAction: (
		sessionId: string,
		messageId: string,
		action: HtmlActionInput,
	) => Promise<void>;
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
			messageId: string,
			content: string,
			answering?: QuestionAnswerParams[],
			attachments?: MessageAttachmentParams[],
		): Promise<void> => {
			await requireClient(getAgentStartClient).request("chat.message", {
				session_id: sessionId,
				message_id: messageId,
				content,
				...(answering && answering.length > 0 ? { answering } : {}),
				...(attachments && attachments.length > 0 ? { attachments } : {}),
			} satisfies MessageParams);
		},

		sendHtmlAction: async (
			sessionId: string,
			messageId: string,
			{ page, action, data }: HtmlActionInput,
		): Promise<void> => {
			// Through the agent-start requester for the reason `chat.message` is:
			// a page's send is a message, and may be what starts the agent.
			await requireClient(getAgentStartClient).request("chat.html_action", {
				session_id: sessionId,
				message_id: messageId,
				page,
				action,
				...(data !== undefined ? { data } : {}),
			} satisfies HtmlActionParams);
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
