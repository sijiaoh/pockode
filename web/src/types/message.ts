import type { ContentBlock } from "./content";
import type { AgentType } from "./settings";
import type { WorkType } from "./work";

export type SessionMode = "default" | "yolo";

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
 * What the agents reported spending, on Anthropic's convention: `input_tokens`
 * counts only what was actually sent, with cache reads and cache writes counted
 * beside it rather than inside it (the Codex parser subtracts its cached tokens
 * back out, server-side). That is what lets the four be added up — the headline
 * total is summed here rather than sent, mirroring `session.TokenUsage.Total()`,
 * because a `total_tokens` on the wire would be a third copy of one fact.
 *
 * Nothing here is ever estimated from a price table: a missing number means the
 * agent reported none, which is not the same as zero.
 */
export interface TokenUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	/** Absent when the agent reports no price at all, as Codex does. */
	cost_usd?: number;
}

/** A session's usage: the counters above, plus where its conversation sits in the window. */
export interface SessionUsage extends TokenUsage {
	/** A level, not a total: compaction makes it fall while the totals climb. */
	context_tokens?: number;
	/** The window that level sits in. Absent means this agent never reported one. */
	context_window?: number;
}

/**
 * One row of the session list: what drawing a row needs, and nothing more.
 *
 * A session's settings — mode, agent type, model, effort, activated — are not
 * here. They come from `session.detail.subscribe`, for the one session that is
 * open; the list goes to every client on every change, and a model chosen in one
 * session is not news to a client reading another.
 *
 * Two fields are also on `SessionDetail`, and neither can drift: both are read
 * straight off the session the server stores, so the row and the detail are two
 * narrowings of one record rather than two accounts of it.
 */
export interface SessionListItem {
	id: string;
	title: string;
	/** The row's subtitle, and what the list is ordered by. */
	updated_at: string;
	/**
	 * What the session is doing, whole. Everything the row draws is derived from
	 * it by `sessionActivity` (web/src/lib/activity.ts) — nothing here is read
	 * field by field, which is the rule this shape exists to make possible.
	 */
	turn: SessionTurn;
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

/**
 * How one tool call stands right now. Derived by the message reducer from the
 * records it has — never sent on the wire, because every input to the
 * derivation already is (docs/tool-call-model.md#toolrun).
 *
 * `background` is not a finished state: it is `running` wearing a badge, for a
 * call that handed its work to something outliving the turn.
 */
export type ToolRunStatus =
	| "running"
	| "background"
	| "success"
	| "error"
	| "interrupted";

/**
 * One tool call and everything known about it, subagent calls included: a Task
 * *is* a tool call, and keeping a second shape for it meant two status
 * machines and two settle-on-interrupt paths for one thing. `TaskItem` stays,
 * as the renderer for that category.
 *
 * The reducer is the only author. A renderer switches on `status` and infers
 * nothing of its own.
 */
export interface ToolRun {
	id: string;
	name: string;
	/** Complete, never truncated: the row's summary is derived from it. */
	input: unknown;
	status: ToolRunStatus;
	/**
	 * The latest one-line status of a call still running. Live state: it comes
	 * from `tool_activity`, which is never persisted, so a replayed run has none
	 * and is still correct — `status` is what carries "still going".
	 */
	activity?: string;
	/** A running call's output so far, accumulated from the deltas. Live state. */
	output?: string;
	/** Empty when the result arrived as `contents` instead. */
	result?: string;
	/**
	 * The result cut into blocks, present only when the agent returned something
	 * that is not prose — an image, a file, a tool it found. It then holds the
	 * whole result, prose included, in the agent's own order.
	 */
	contents?: ContentBlock[];
	/**
	 * What this call handed back to the agent while its real work carried on:
	 * the placeholder text of a backgrounded call. Kept beside the outcome
	 * rather than replaced by it — showing only the outcome would assert the
	 * agent read something it never did.
	 */
	placeholderResult?: string;
	/** Set once the call is known to have left work running past the turn. */
	fromBackground?: boolean;
	/**
	 * How long the call took, when the engine reported it as a figure (Codex
	 * does, Claude does not). Never inferred from arrival times: a replayed
	 * record has no honest one.
	 */
	durationMs?: number;
	/** The command's exit status, when the engine reports one separately. */
	exitCode?: number;
	/**
	 * When this client first saw the call. Live only — a history record carries
	 * no timestamp, so a replayed run gets none and draws no stopwatch.
	 */
	seenAt?: Date;
}

export type PermissionStatus = "pending" | "allowed" | "denied" | "expired";

export type QuestionStatus = "pending" | "answered" | "cancelled" | "expired";

export type ContentPart =
	| { type: "text"; content: string }
	| { type: "tool_call"; tool: ToolRun }
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
	 * The work whose session received this message. Absent on history recorded
	 * before it was sent, which then offers no way into the work's detail view.
	 */
	work_id?: string;
	work_type?: WorkType;
	title?: string;
	/**
	 * Where the work stood when this message was sent. A historical fact: it is
	 * what this event's own wording says, never the work's current position.
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

export type Message = UserMessage | AssistantMessage;

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

/**
 * Why the worktree setup script does not run on the server's machine.
 * Absent means it runs.
 */
export interface SetupHookSkip {
	reason: string;
	hint: string;
}

export interface WorktreeListResult {
	worktrees: WorktreeInfo[];
	/** Set when creating a worktree would skip the setup script. */
	setup_hook_skip?: SetupHookSkip;
}

export interface WorktreeCreateParams {
	name: string;
	branch: string;
	base_branch?: string;
}

export interface WorktreeCreateResult {
	worktree: WorktreeInfo;
	/** Set when the worktree was created but its setup script did not run. */
	setup_hook_skip?: SetupHookSkip;
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
	 * Ceiling on one upload request, in bytes, sent so a client can refuse an
	 * oversized file before spending a slow link on it instead of keeping its
	 * own copy of the number. The same on every route — the relay tunnel
	 * streams a request body and imposes no ceiling of its own — but still read
	 * from this reply rather than hard-coded (see docs/file.md#transfer).
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
	/** What the session is doing. The same value the session's row carries. */
	turn: SessionTurn;
	unread: boolean;
	/** Absent on a session that was created rather than forked. */
	forked_from?: ForkOrigin;
	/**
	 * Always present: a session that has spent nothing carries an empty usage,
	 * not a missing one, which is what "nothing reported yet" is keyed on.
	 */
	usage: SessionUsage;
}

export interface SessionDetailSubscribeResult {
	session: SessionDetail;
}

/** What a turn is stuck on. Only one kind is ever the user's to clear twice
 * over: `permission` and `question` need an answer, `background` needs the
 * agent's own work to finish. */
export type TurnBlockerKind = "permission" | "question" | "background";

export interface TurnBlocker {
	kind: TurnBlockerKind;
	/** The agent's id for the prompt an answer names. Absent on `background`. */
	request_id?: string;
	raised_at: string;
}

/** `blocked` is exactly "there is at least one blocker": the server derives the
 * phase rather than letting it drift from them, so nothing here has to look past
 * `phase` to find out. */
export type TurnPhase = "idle" | "running" | "blocked";

export type TurnOutcome = "completed" | "failed" | "aborted";

export interface SessionTurn {
	phase: TurnPhase;
	/**
	 * Whether a turn is under way behind whatever is in its way. It differs from
	 * `phase !== "idle"` in exactly one case: a CLI can raise a prompt after the
	 * turn it belonged to already ended, which is `blocked` with nothing running.
	 */
	open: boolean;
	blockers?: TurnBlocker[];
	/** When the current phase was entered; it does not move while it holds. */
	since: string;
	/** How the previous turn ended. Cleared the moment a new one starts, so it
	 * says nothing while `phase` is not `idle`. */
	last_outcome?: TurnOutcome;
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
	/**
	 * What the session is doing at the moment of subscribing. The transcript's
	 * own subscription reports it because the transcript is what it governs — the
	 * session's settings come from `session.detail.subscribe` instead.
	 *
	 * It is what closes out a transcript whose server died mid-stream: a turn
	 * that is not running says every bubble still `streaming` has stopped, which
	 * history cannot say on its own (docs/lifecycle-ui.md §2.4).
	 */
	turn: SessionTurn;
	/**
	 * What each call still in flight last reported doing, by `tool_use_id`. Not
	 * in `history`: a `tool_activity` is never recorded, and this is how a client
	 * that subscribes mid-run — the normal case on a phone — learns what a
	 * background call that started half an hour ago is up to. Absent when no call
	 * is in flight; a transcript with none is still correct, because the spinner
	 * and the badge come from the derived status.
	 */
	tool_activity?: Record<string, string>;
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
	| "tool_activity"
	| "warning"
	| "error"
	| "done"
	| "interrupted"
	| "process_ended"
	| "background_wait"
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
			/** Absent when the result was prose alone; see `ToolRun.contents`. */
			contents?: ContentBlock[];
			/** Absent unless the agent CLI reported the tool call as failed. */
			is_error?: boolean;
			/**
			 * What kind of result this is, for the results that are not simply
			 * "what the call produced": `background_started` marks the placeholder
			 * a backgrounded call handed back, `background_result` the real
			 * outcome that arrived after the turn, and `background_lost` the one
			 * Pockode wrote itself after the CLI process died with the work still
			 * running. Absent on every ordinary one.
			 */
			subtype?: string;
			/** Absent, or 0, from an engine that reports no duration (Claude). */
			duration_ms?: number;
			/** Absent for every tool that is not a command that ran. */
			exit_code?: number;
	  }
	| {
			/**
			 * What a call that has not returned is doing. Never persisted, so it
			 * carries no seq and never appears in a history page: `activity` is a
			 * latest value and `output_delta` accumulates.
			 */
			type: "tool_activity";
			tool_use_id: string;
			activity?: string;
			output_delta?: string;
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
			/**
			 * The turn parked on work that outlives the tool call that started it.
			 * Neither an ending nor output: the CLI resumes by itself when the work
			 * finishes (agent-integration.md#background-waits).
			 */
			type: "background_wait";
	  }
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
