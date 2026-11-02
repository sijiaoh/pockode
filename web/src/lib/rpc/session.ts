import {
	JSONRPCErrorCode,
	JSONRPCErrorException,
	type JSONRPCRequester,
} from "json-rpc-2.0";
import type {
	AgentEfforts,
	AgentModels,
	HistorySeq,
	SessionDeleteParams,
	SessionEffortsResult,
	SessionForkParams,
	SessionListItem,
	SessionMode,
	SessionModelsResult,
	SessionSetAgentTypeParams,
	SessionSetEffortParams,
	SessionSetHTMLFirstParams,
	SessionSetModelParams,
	SessionSetModeParams,
	SessionUpdateTitleParams,
} from "../../types/message";
import type { AgentType } from "../../types/settings";

/**
 * Why the server refused a `session.set_html_first`: `session_started` once the
 * first message has been delivered, `work_session` for a work item's session,
 * and `not_found` for a session that is gone — the one refusal of this method
 * that is `InvalidParams` with no `data`, as on every `session.*` method.
 * Null for anything else (a disconnect, an internal error). Recognised by the
 * code and `data.reason`, never the message, which is prose the server may
 * reword.
 */
export type HtmlFirstRefusedReason =
	| "session_started"
	| "work_session"
	| "not_found";

export function htmlFirstRefusedReason(
	error: unknown,
): HtmlFirstRefusedReason | null {
	if (
		!(error instanceof JSONRPCErrorException) ||
		error.code !== JSONRPCErrorCode.InvalidParams
	) {
		return null;
	}
	if (error.data === undefined || error.data === null) return "not_found";
	const reason = (error.data as { reason?: unknown }).reason;
	return reason === "session_started" || reason === "work_session"
		? reason
		: null;
}

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
	setSessionModel: (sessionId: string, model: string) => Promise<void>;
	setSessionEffort: (sessionId: string, effort: string) => Promise<void>;
	/** Refused once the session has started; see `htmlFirstRefusedReason`. */
	setSessionHTMLFirst: (sessionId: string, htmlFirst: boolean) => Promise<void>;
	/** The models selectable per agent type. Server-wide constants. */
	listModels: () => Promise<AgentModels>;
	/** The effort levels selectable per agent type. Server-wide constants. */
	listEfforts: () => Promise<AgentEfforts>;
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

		setSessionModel: async (
			sessionId: string,
			model: string,
		): Promise<void> => {
			await requireClient().request("session.set_model", {
				session_id: sessionId,
				model,
			} as SessionSetModelParams);
		},

		setSessionEffort: async (
			sessionId: string,
			effort: string,
		): Promise<void> => {
			await requireClient().request("session.set_effort", {
				session_id: sessionId,
				effort,
			} as SessionSetEffortParams);
		},

		setSessionHTMLFirst: async (
			sessionId: string,
			htmlFirst: boolean,
		): Promise<void> => {
			await requireClient().request("session.set_html_first", {
				session_id: sessionId,
				html_first: htmlFirst,
			} as SessionSetHTMLFirstParams);
		},

		listModels: async (): Promise<AgentModels> => {
			const result: SessionModelsResult = await requireClient().request(
				"session.models",
				{},
			);
			return result.models;
		},

		listEfforts: async (): Promise<AgentEfforts> => {
			const result: SessionEffortsResult = await requireClient().request(
				"session.efforts",
				{},
			);
			return result.efforts;
		},

		markSessionRead: async (sessionId: string): Promise<void> => {
			await requireClient().request("session.mark_read", {
				session_id: sessionId,
			});
		},
	};
}
