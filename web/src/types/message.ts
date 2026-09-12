import type { AgentType } from "./settings";
import type { WorkType } from "./work";

export type SessionMode = "default" | "yolo";
export type ProcessState = "idle" | "running" | "ended";

/**
 * Where a forked session came from. Only the parent's id: the client resolves
 * it against the session list it already holds, and a parent that is gone from
 * that list is exactly the "forked from a deleted session" case. Copying the
 * title here instead would keep showing the old one after a rename.
 */
export interface ForkOrigin {
	session_id: string;
}

/**
 * One row of the session list: what drawing a row needs, and nothing more.
 *
 * A session's settings — mode, agent type, model, effort, activated — are not
 * here. They come from `session.detail.subscribe`, for the one session that is
 * open; the list goes to every client on every change, and a model chosen in one
 * session is not news to a client reading another.
 *
 * Two fields are also on `SessionDetail`, and neither can drift: `state` is
 * volatile process state the list owns outright and detail never carries, and
 * `forked_from` is fixed when the session is born and never written again.
 */
export interface SessionListItem {
	id: string;
	title: string;
	/** The row's subtitle, and what the list is ordered by. */
	updated_at: string;
	state: ProcessState;
	needs_input: boolean;
	unread: boolean;
	/** Absent on a session that was created rather than forked. */
	forked_from?: ForkOrigin;
}

/**
 * One history record's address: its 1-based position in the session's history,
 * assigned by the server and only ever quoted back. Never counted client-side —
 * some records are written without being broadcast, so a local counter drifts
 * and a fork would then cut in the wrong place (docs/session-fork-ui.md).
 */
export type HistorySeq = number;

export type MessageStatus =
	| "sending"
	| "streaming"
	| "complete"
	| "error"
	| "interrupted"
	| "process_ended";

export interface ToolCall {
	id: string;
	name: string;
	input: unknown;
	result?: string;
}

export type PermissionStatus = "pending" | "allowed" | "denied" | "expired";

export type QuestionStatus = "pending" | "answered" | "cancelled" | "expired";

export type TaskRunStatus = "running" | "done" | "failed" | "interrupted";

/**
 * The current state of one Claude Task (subagent) call. Maintained solely by
 * the message reducer, so the UI never has to infer a Task's state from the
 * events that produced it.
 */
export interface TaskRun {
	toolUseId: string;
	/** Task input.description, falling back to subagentType, then "Task". */
	description: string;
	subagentType?: string;
	/** Task input.prompt — the only place the subagent's brief is visible. */
	prompt?: string;
	status: TaskRunStatus;
	result?: string;
	/**
	 * A result that arrived after the turn was cut short. The content is kept,
	 * but the status stays interrupted: a late result cannot make the UI claim
	 * the Task finished normally.
	 */
	resultAfterInterrupt?: boolean;
}

export type ContentPart =
	| { type: "text"; content: string }
	| { type: "tool_call"; tool: ToolCall }
	| { type: "system"; content: string }
	| { type: "warning"; message: string; code: string }
	| {
			type: "permission_request";
			request: PermissionRequest;
			status: PermissionStatus;
	  }
	| {
			type: "ask_user_question";
			request: AskUserQuestionRequest;
			status: QuestionStatus;
			answers?: Record<string, string>;
	  }
	| {
			/**
			 * Every Task of one turn, folded into a single part anchored where the
			 * first of them landed.
			 */
			type: "task_group";
			tasks: TaskRun[];
	  }
	| { type: "raw"; content: string }
	| { type: "command_output"; content: string };

// Origin of a message: user-typed vs. Pockode's own system automation.
// Absent/"user" = a normal user message (backward compatible with old history).
export type MessageOrigin = "user" | "system";

export interface SystemMessageStep {
	current: number;
	total: number;
}

export interface SystemMessageChild {
	id: string;
	title: string;
}

// Summary data for a system-origin message, used to render it without parsing
// the prompt body. Mirrors agent.MessageMeta on the server.
export interface SystemMessageMeta {
	/**
	 * The work whose session received this message — the aggregation key for the
	 * work card. Absent on history recorded before the card existed, which falls
	 * back to a standalone banner.
	 */
	work_id?: string;
	work_type?: WorkType;
	title?: string;
	/**
	 * Where the work stood when this message was sent. A historical fact: use it
	 * for timeline wording, never as the work's current position.
	 */
	step?: SystemMessageStep;
	child?: SystemMessageChild;
}

export interface UserMessage {
	id: string;
	role: "user";
	content: string;
	status: MessageStatus;
	createdAt: Date;
	/**
	 * The last history record folded into this message, and so the cut point a
	 * fork anchored here uses. Absent when no record the client saw carries one:
	 * a record that could not be persisted, or a message this client sent itself
	 * talking to a server too old to answer `chat.message` with a seq (see
	 * `MessageResult`). Not history written before seqs existed — replay stamps
	 * those by position.
	 */
	anchorSeq?: HistorySeq;
	// Present only for system-driven messages; absent means a user-typed message.
	source?: MessageOrigin;
	subtype?: string;
	meta?: SystemMessageMeta;
}

export interface AssistantMessage {
	id: string;
	role: "assistant";
	parts: ContentPart[];
	status: MessageStatus;
	error?: string;
	createdAt: Date;
	/** See `UserMessage.anchorSeq`. */
	anchorSeq?: HistorySeq;
}

/** One system message, folded into the card's collapsed timeline. */
export interface WorkTimelineEntry {
	id: string;
	subtype?: string;
	/** The full prompt body, so nothing the old banner showed is lost. */
	content: string;
	step?: SystemMessageStep;
	child?: SystemMessageChild;
}

/**
 * Every system message of one work, collapsed into a single card anchored where
 * the first of them landed. It deliberately carries no status: the card reads
 * that live from the work store, because a work can change state (an interrupt,
 * for one) without producing any message at all.
 */
export interface WorkCardMessage {
	id: string;
	role: "work";
	workId: string;
	/** Recorded at anchor time; only used when the work is gone from the store. */
	workType?: WorkType;
	title?: string;
	entries: WorkTimelineEntry[];
	createdAt: Date;
}

/**
 * A hairline in the stream marking where the work moved to a new step. It says
 * only "the step changed here" — carrying no status, it can never contradict
 * the card.
 */
export interface StepDividerMessage {
	id: string;
	role: "step_divider";
	workId: string;
	step: SystemMessageStep;
	createdAt: Date;
}

export type Message =
	| UserMessage
	| AssistantMessage
	| WorkCardMessage
	| StepDividerMessage;

export type PermissionBehavior = "allow" | "deny" | "ask";

export type PermissionUpdateDestination =
	| "userSettings"
	| "projectSettings"
	| "localSettings"
	| "session";

export interface PermissionRuleValue {
	toolName: string;
	ruleContent?: string;
}

export type PermissionUpdate =
	| {
			type: "addRules";
			rules: PermissionRuleValue[];
			behavior: PermissionBehavior;
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "replaceRules";
			rules: PermissionRuleValue[];
			behavior: PermissionBehavior;
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "removeRules";
			rules: PermissionRuleValue[];
			behavior: PermissionBehavior;
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "setMode";
			mode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "addDirectories";
			directories: string[];
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "removeDirectories";
			directories: string[];
			destination: PermissionUpdateDestination;
	  };

export interface PermissionRequest {
	requestId: string;
	toolName: string;
	toolInput: unknown;
	toolUseId: string;
	permissionSuggestions?: PermissionUpdate[];
}

export interface QuestionOption {
	label: string;
	description: string;
}

export interface AskUserQuestion {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

export interface AskUserQuestionRequest {
	requestId: string;
	toolUseId: string;
	questions: AskUserQuestion[];
}

// JSON-RPC 2.0 Request Params (Client → Server)

export interface AuthParams {
	token: string;
	worktree?: string;
}

export interface WorktreeInfo {
	name: string;
	path: string;
	branch: string;
	is_main: boolean;
}

export interface WorktreeListResult {
	worktrees: WorktreeInfo[];
}

export interface WorktreeCreateParams {
	name: string;
	branch: string;
	base_branch?: string;
}

export interface WorktreeDeleteParams {
	name: string;
}

export interface WorktreeDeletedNotification {
	name: string;
}

export interface AuthResult {
	version: string;
	title: string;
	work_dir: string;
	/**
	 * Ceiling on one upload request, in bytes, for the route this connection
	 * came in on — not a property of the server. A relay connection is bounded
	 * by what the tunnel can carry, well under what the endpoint would store,
	 * and one server answers both kinds at once. Read it from this reply and
	 * replace it on every reconnect (see docs/file.md#transfer).
	 */
	max_upload_size: number;
}

export interface MessageParams {
	session_id: string;
	content: string;
}

/**
 * The reply to `chat.message`: where the server put the message just sent.
 *
 * This client is left out of the broadcast that carries every other record's
 * seq — it already echoed the message into its own transcript — so this reply is
 * the only place it learns the address of its own message, and without it that
 * message could not be forked from until the session was reloaded.
 *
 * `seq` is absent when the record was not persisted, and from servers too old to
 * send it at all. Both mean the same thing here and neither is an error: the
 * message stays unaddressable, which is what every locally sent message used to
 * be.
 */
export interface MessageResult {
	seq?: HistorySeq;
}

export interface InterruptParams {
	session_id: string;
}

export interface PermissionResponseParams {
	session_id: string;
	request_id: string;
	tool_use_id: string;
	tool_input: unknown;
	permission_suggestions?: PermissionUpdate[];
	choice: "deny" | "allow" | "always_allow";
}

export interface QuestionResponseParams {
	session_id: string;
	request_id: string;
	tool_use_id: string;
	answers: Record<string, string> | null; // null = cancel
}

export interface SessionDeleteParams {
	session_id: string;
}

export interface SessionUpdateTitleParams {
	session_id: string;
	title: string;
}

export interface SessionForkParams {
	session_id: string;
	/**
	 * The seq of the message the user picked, quoted back unchanged.
	 *
	 * How much the fork keeps is the server's to decide, not this client's: an
	 * agent message is kept, a message the user sent is not, because the fork
	 * returns to before they sent it. Never do arithmetic on this — a seq is an
	 * address the server handed out, not an index (see `chat.Client.Fork` and
	 * docs/session-fork-ui.md, *The rule*).
	 */
	anchor_seq: HistorySeq;
	/** Empty copies the source session's title. */
	title?: string;
}

export interface SessionListSubscribeResult {
	id: string;
	sessions: SessionListItem[];
}

export type SessionListChangedNotification =
	| { id: string; operation: "create" | "update"; session: SessionListItem }
	| { id: string; operation: "delete"; sessionId: string }
	| { id: string; operation: "sync"; sessions: SessionListItem[] };

/**
 * One session's persistent metadata, as `session.detail.subscribe` reports it
 * (the server's `session.SessionMeta`).
 *
 * No process state: whether an agent is running is volatile state the server
 * pushes through the session list, and a second copy of it here would arrive in
 * an order neither side controls, leaving no way to tell which of the two is
 * current (server/watch/session_detail.go).
 *
 * Spelled out rather than derived from `SessionListItem`: the two are separate
 * wire shapes answering different questions — what a session is, versus what a
 * row of the list draws — and the list carries only the handful of fields a row
 * needs. Deriving one from the other would make every future change to a row
 * silently change what a session is.
 */
export interface SessionDetail {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
	mode: SessionMode;
	agent_type: AgentType;
	/** Empty means "pass no model flag, let the CLI pick". */
	model: string;
	/** Empty means "pass no effort flag, let the CLI keep its default". */
	effort: string;
	/** True once the agent has produced output in this session. */
	activated: boolean;
	needs_input: boolean;
	unread: boolean;
	/** Absent on a session that was created rather than forked. */
	forked_from?: ForkOrigin;
}

export interface SessionDetailSubscribeResult {
	id: string;
	session: SessionDetail;
}

/** A deleted session reports no metadata; `deleted` is set exactly then. */
export type SessionDetailChangedNotification =
	| { id: string; session: SessionDetail; deleted?: false }
	| { id: string; session?: undefined; deleted: true };

export interface ChatMessagesSubscribeParams {
	session_id: string;
	/** Omitted asks for the server's default page size. */
	limit?: number;
}

/**
 * One page of history, oldest record first.
 *
 * `next_before_seq` is the cursor for the page before this one and is absent
 * once `has_more` is false. It is the only way to ask for an earlier page: a
 * record the server could not address carries no seq, so a cursor derived from
 * `history[0]` would eventually name nothing. The two fields say the same thing,
 * and the client reads the cursor — the one of them it can act on.
 */
export interface ChatMessagesHistoryPage {
	history: unknown[];
	has_more: boolean;
	next_before_seq?: HistorySeq;
}

export interface ChatMessagesSubscribeResult extends ChatMessagesHistoryPage {
	id: string;
	/**
	 * Whether a process is running for this session. The transcript's own
	 * subscription reports it because the transcript is what it governs — the
	 * session's settings come from `session.detail.subscribe` instead.
	 */
	state: ProcessState;
}

export interface ChatMessagesHistoryParams {
	session_id: string;
	/** Exclusive: the reply holds the records immediately older than this one. */
	before_seq?: HistorySeq;
	limit?: number;
}

export type ChatMessagesHistoryResult = ChatMessagesHistoryPage;

export interface SessionSetModeParams {
	session_id: string;
	mode: SessionMode;
}

export interface SessionSetAgentTypeParams {
	session_id: string;
	agent_type: AgentType;
}

export interface SessionSetModelParams {
	session_id: string;
	model: string;
}

export interface SessionSetEffortParams {
	session_id: string;
	effort: string;
}

/**
 * One selectable option of an agent, as the server lists it — a model or an
 * effort level. The two are the same shape because they are the same kind of
 * thing: a server-side constant the UI may only choose from, never extend.
 */
export interface AgentOption {
	id: string;
	label: string;
}

/** The selectable models of every agent type, as `session.models` returns them. */
export type AgentModels = Record<AgentType, AgentOption[]>;

export interface SessionModelsResult {
	models: AgentModels;
}

/**
 * The selectable effort levels of every agent type, as `session.efforts`
 * returns them. Partial: an agent with no notion of effort is absent rather
 * than present with an empty list.
 */
export type AgentEfforts = Partial<Record<AgentType, AgentOption[]>>;

export interface SessionEffortsResult {
	efforts: AgentEfforts;
}

// JSON-RPC 2.0 Notification Params (Server → Client)
// These match the EventRecord format from the server.

export type ServerMethod =
	| "text"
	| "tool_call"
	| "tool_result"
	| "warning"
	| "error"
	| "done"
	| "interrupted"
	| "process_ended"
	| "permission_request"
	| "ask_user_question"
	| "request_cancelled"
	| "system"
	| "message"
	| "command_output";

export type ServerNotification =
	| { type: "text"; content: string }
	| {
			type: "message";
			content: string;
			origin?: MessageOrigin;
			subtype?: string;
			meta?: SystemMessageMeta;
	  }
	| {
			type: "tool_call";
			tool_name: string;
			tool_input: unknown;
			tool_use_id: string;
	  }
	| {
			type: "tool_result";
			tool_use_id: string;
			tool_result: string;
			/** Absent unless the agent CLI reported the tool call as failed. */
			is_error?: boolean;
	  }
	| {
			type: "warning";
			message: string;
			code: string;
	  }
	| { type: "error"; error: string }
	| { type: "done" }
	| { type: "interrupted" }
	| { type: "process_ended" }
	| {
			type: "permission_request";
			request_id: string;
			tool_name: string;
			tool_input: unknown;
			tool_use_id: string;
			permission_suggestions?: PermissionUpdate[];
	  }
	| {
			type: "ask_user_question";
			request_id: string;
			tool_use_id: string;
			questions: AskUserQuestion[];
	  }
	| {
			type: "request_cancelled";
			request_id: string;
	  }
	| { type: "system"; content: string }
	| { type: "command_output"; content: string };
