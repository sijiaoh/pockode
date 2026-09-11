import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	HistorySeq,
	SessionDeleteParams,
	SessionForkParams,
	SessionListItem,
	SessionMode,
	SessionSetAgentTypeParams,
	SessionSetModeParams,
	SessionUpdateTitleParams,
} from "../../types/message";
import type { AgentType } from "../../types/settings";

export interface SessionActions {
	createSession: () => Promise<SessionListItem>;
	/**
	 * Creates a session holding this session's conversation up to the moment
	 * before the record named by `anchorSeq` happened — which keeps that record
	 * when the agent produced it and drops it when the user sent it, the server's
	 * call either way (`SessionForkParams.anchor_seq`). The source session is
	 * left untouched.
	 */
	forkSession: (
		sessionId: string,
		anchorSeq: HistorySeq,
		title: string,
	) => Promise<SessionListItem>;
	deleteSession: (sessionId: string) => Promise<void>;
	updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
	setSessionMode: (sessionId: string, mode: SessionMode) => Promise<void>;
	setSessionAgentType: (
		sessionId: string,
		agentType: AgentType,
	) => Promise<void>;
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

		forkSession: async (
			sessionId: string,
			anchorSeq: HistorySeq,
			title: string,
		): Promise<SessionListItem> => {
			return requireClient().request("session.fork", {
				session_id: sessionId,
				anchor_seq: anchorSeq,
				title,
			} as SessionForkParams);
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

		markSessionRead: async (sessionId: string): Promise<void> => {
			await requireClient().request("session.mark_read", {
				session_id: sessionId,
			});
		},
	};
}
