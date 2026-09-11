import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	AgentModels,
	SessionDeleteParams,
	SessionListItem,
	SessionMode,
	SessionModelsResult,
	SessionSetAgentTypeParams,
	SessionSetModelParams,
	SessionSetModeParams,
	SessionUpdateTitleParams,
} from "../../types/message";
import type { AgentType } from "../../types/settings";

export interface SessionActions {
	createSession: () => Promise<SessionListItem>;
	deleteSession: (sessionId: string) => Promise<void>;
	updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
	setSessionMode: (sessionId: string, mode: SessionMode) => Promise<void>;
	setSessionAgentType: (
		sessionId: string,
		agentType: AgentType,
	) => Promise<void>;
	setSessionModel: (sessionId: string, model: string) => Promise<void>;
	/** The models selectable per agent type. Server-wide constants. */
	listModels: () => Promise<AgentModels>;
	markSessionRead: (sessionId: string) => Promise<void>;
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
		createSession: async (): Promise<SessionListItem> => {
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

		setSessionMode: async (
			sessionId: string,
			mode: SessionMode,
		): Promise<void> => {
			await requireClient().request("session.set_mode", {
				session_id: sessionId,
				mode,
			} as SessionSetModeParams);
		},

		setSessionAgentType: async (
			sessionId: string,
			agentType: AgentType,
		): Promise<void> => {
			await requireClient().request("session.set_agent_type", {
				session_id: sessionId,
				agent_type: agentType,
			} as SessionSetAgentTypeParams);
		},

		setSessionModel: async (
			sessionId: string,
			model: string,
		): Promise<void> => {
			await requireClient().request("session.set_model", {
				session_id: sessionId,
				model,
			} as SessionSetModelParams);
		},

		listModels: async (): Promise<AgentModels> => {
			const result: SessionModelsResult = await requireClient().request(
				"session.models",
				{},
			);
			return result.models;
		},

		markSessionRead: async (sessionId: string): Promise<void> => {
			await requireClient().request("session.mark_read", {
				session_id: sessionId,
			});
		},
	};
}
