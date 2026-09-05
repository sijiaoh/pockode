import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	InterruptParams,
	MessageParams,
	PermissionResponseParams,
	QuestionResponseParams,
} from "../../types/message";

export interface ChatActions {
	sendMessage: (sessionId: string, content: string) => Promise<void>;
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
		sendMessage: async (sessionId: string, content: string): Promise<void> => {
			await requireClient(getAgentStartClient).request("chat.message", {
				session_id: sessionId,
				content,
			} as MessageParams);
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
