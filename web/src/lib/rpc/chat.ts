import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	HistorySeq,
	InterruptParams,
	MessageParams,
	MessageResult,
	PermissionResponseParams,
	QuestionResponseParams,
} from "../../types/message";
import { readHistorySeq } from "../messageReducer";

export interface ChatActions {
	/**
	 * Resolves with the seq the server gave the message, so the caller can name
	 * that record — undefined when it has no address to give (see
	 * `MessageResult`), which is not a failure.
	 */
	sendMessage: (
		sessionId: string,
		content: string,
	) => Promise<HistorySeq | undefined>;
	interrupt: (sessionId: string) => Promise<void>;
	permissionResponse: (params: PermissionResponseParams) => Promise<void>;
	questionResponse: (params: QuestionResponseParams) => Promise<void>;
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
		): Promise<HistorySeq | undefined> => {
			const result = (await requireClient(getAgentStartClient).request(
				"chat.message",
				{
					session_id: sessionId,
					content,
				} as MessageParams,
			)) as MessageResult | undefined;
			// Decoded by the same reader as a seq arriving on a notification, because
			// it is the same field with the same rule: a server too old to send one
			// answers with an empty object, and the missing field must stay absent
			// rather than become a seq of 0, which names no record.
			return readHistorySeq(result);
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

		questionResponse: async (params: QuestionResponseParams): Promise<void> => {
			await requireClient().request("chat.question_response", params);
		},
	};
}
