import type { JSONRPCClient } from "json-rpc-2.0";
import type {
	AttachParams,
	AttachResult,
	InterruptParams,
	MessageParams,
	PermissionResponseParams,
	QuestionResponseParams,
} from "../../types/message";

export interface ChatActions {
	attach: (sessionId: string) => Promise<AttachResult>;
	sendMessage: (sessionId: string, content: string) => Promise<void>;
	interrupt: (sessionId: string) => Promise<void>;
	permissionResponse: (params: PermissionResponseParams) => Promise<void>;
	questionResponse: (params: QuestionResponseParams) => Promise<void>;
}

export function createChatActions(
	getClient: () => JSONRPCClient | null,
): ChatActions {
	const requireClient = (): JSONRPCClient => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		attach: async (sessionId: string): Promise<AttachResult> => {
			return requireClient().request("chat.attach", {
				session_id: sessionId,
			} as AttachParams);
		},

		sendMessage: async (sessionId: string, content: string): Promise<void> => {
			await requireClient().request("chat.message", {
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
