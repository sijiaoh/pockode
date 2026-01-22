import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	SessionDeleteParams,
	SessionMeta,
	SessionUpdateTitleParams,
} from "../../types/message";

export interface SessionActions {
	createSession: () => Promise<SessionMeta>;
	deleteSession: (sessionId: string) => Promise<void>;
	updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
}

export function createSessionActions(
	getClient: () => JSONRPCRequester<void> | null,
): SessionActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		createSession: async (): Promise<SessionMeta> => {
			return requireClient().request("session.create", {});
		},

		deleteSession: async (sessionId: string): Promise<void> => {
			await requireClient().request("session.delete", {
				session_id: sessionId,
			} as SessionDeleteParams);
		},

		updateSessionTitle: async (
			sessionId: string,
			title: string,
		): Promise<void> => {
			await requireClient().request("session.update_title", {
				session_id: sessionId,
				title,
			} as SessionUpdateTitleParams);
		},
	};
}
