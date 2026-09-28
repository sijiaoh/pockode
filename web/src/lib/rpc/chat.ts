import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	HistorySeq,
	InterruptParams,
	MessageParams,
	MessageResult,
	PermissionResponseParams,
	PockodeCommandInvocation,
	QuestionAnswerParams,
} from "../../types/message";
import { normalizeCommand, readHistorySeq } from "../messageReducer";

/** What the server said about a message it accepted; see `MessageResult`. */
export interface SentMessage {
	seq?: HistorySeq;
	/**
	 * Present only when the message invoked a Pockode command: the prompt the
	 * agent was sent in its place, and the command as the server parsed it.
	 */
	expanded?: { content: string; command: PockodeCommandInvocation };
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
	) => Promise<SentMessage>;
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
		): Promise<SentMessage> => {
			const result = (await requireClient(getAgentStartClient).request(
				"chat.message",
				{
					session_id: sessionId,
					content,
					...(answering && answering.length > 0 ? { answering } : {}),
				} as MessageParams,
			)) as MessageResult | undefined;
			// Decoded by the same reader as a seq arriving on a notification, because
			// it is the same field with the same rule: a server too old to send one
			// answers with an empty object, and the missing field must stay absent
			// rather than become a seq of 0, which names no record.
			const seq = readHistorySeq(result);
			const command = normalizeCommand(result?.command);
			return {
				...(seq !== undefined ? { seq } : {}),
				...(command && typeof result?.content === "string"
					? { expanded: { content: result.content, command } }
					: {}),
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
