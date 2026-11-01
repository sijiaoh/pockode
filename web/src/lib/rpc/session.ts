import {
	JSONRPCErrorCode,
	JSONRPCErrorException,
	type JSONRPCRequester,
} from "json-rpc-2.0";
import type {
	AgentEfforts,
	AgentModels,
	HistorySeq,
	SessionCreateParams,
	SessionDeleteParams,
	SessionEffortsResult,
	SessionForkParams,
	SessionListItem,
	SessionMode,
	SessionModelsResult,
	SessionSetAgentTypeParams,
	SessionSetCanvasParams,
	SessionSetEffortParams,
	SessionSetModelParams,
	SessionSetModeParams,
	SessionUpdateTitleParams,
} from "../../types/message";
import type { AgentType } from "../../types/settings";

/**
 * Whether `session.set_canvas` was refused because the session's first message
 * got there first: its kind is fixed from then on (docs/new-session-ui.md
 * §4.1). Read from the error's data, which the server keeps stable, rather
 * than from the message, which it may reword.
 */
export function isSessionStartedRefusal(error: unknown): boolean {
	return (
		error instanceof JSONRPCErrorException &&
		error.code === JSONRPCErrorCode.InvalidParams &&
		(error.data as { reason?: unknown } | undefined)?.reason ===
			"session_started"
	);
}

export interface SessionActions {
	createSession: (params?: SessionCreateParams) => Promise<SessionListItem>;
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
	/**
	 * Creates a session holding a canvas session's conversation up to the
	 * moment the page `revision` had just been drawn, opening on that page
	 * (docs/canvas-ui.md §13.6). Refused, `InvalidParams`, for a revision that
	 * is not there and for one its entry's `fork_blocked` names.
	 */
	forkSessionAtCanvasRevision: (
		sessionId: string,
		revision: number,
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
	/** Refused once the session has started; see `isSessionStartedRefusal`. */
	setSessionCanvas: (sessionId: string, canvas: boolean) => Promise<void>;
	setSessionEffort: (sessionId: string, effort: string) => Promise<void>;
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
		createSession: async (
			params: SessionCreateParams = {},
		): Promise<SessionListItem> => {
			return requireClient().request("session.create", params);
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

		forkSessionAtCanvasRevision: async (
			sessionId: string,
			revision: number,
			title: string,
		): Promise<SessionListItem> => {
			return requireClient().request("session.fork", {
				session_id: sessionId,
				canvas_revision: revision,
				title,
			} satisfies SessionForkParams);
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

		setSessionCanvas: async (
			sessionId: string,
			canvas: boolean,
		): Promise<void> => {
			await requireClient().request("session.set_canvas", {
				session_id: sessionId,
				canvas,
			} as SessionSetCanvasParams);
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
