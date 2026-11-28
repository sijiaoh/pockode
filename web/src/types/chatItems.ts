/**
 * The transcript as the server sends it: pages of items grouped into turns,
 * and the updates and stream deltas that keep a page current
 * (docs/agent-chat.md#history-paging, #live-updates).
 *
 * Hand-written: these mirror `server/projection/page.go` and `update.go`,
 * which the wire type generator does not cover. The nested record payloads it
 * does cover come from `wire.generated.ts`.
 */
import type { HistorySeq } from "./message";
import type * as Wire from "./wire.generated";

/** `projection.Turn`. */
export interface ChatTurn {
	turn_id: string;
	origin: Wire.TurnOrigin;
	message_id?: string;
	started_at?: string;
	start_seq?: HistorySeq;
	ended: boolean;
	outcome?: "completed" | "failed" | "auth_failed" | "aborted" | (string & {});
	/** The signal that ended it: says whether an aborted turn was interrupted. */
	ended_by?: string;
	end_seq?: HistorySeq;
	ended_at?: string;
}

/** `projection.DiscardedMessage`. */
export interface DiscardedMessage {
	message_id?: string;
	excerpt?: string;
	seq?: HistorySeq;
}

export interface PageTurn {
	turn?: ChatTurn;
	continued?: boolean;
	items: PageItem[];
	discarded?: DiscardedMessage[];
}

export type ItemKind =
	| "message"
	| "text"
	| "thinking"
	| "tool"
	| "question"
	| "plan"
	| "read"
	| "system"
	| "warning"
	| "error"
	| "raw"
	| "command_output";

export interface MessageItem {
	message_id?: string;
	content?: string;
	observed_at?: string;
	origin?: Wire.MessageOrigin | "work";
	subtype?: Wire.MessageSubtype;
	meta?: Wire.MessageMeta;
	answering?: Wire.QuestionAnswer[];
	command?: Wire.CommandInvocation;
	html_action?: Wire.Action;
	attachments?: Wire.FileBlock[];
	discarded?: boolean;
}

export interface TextItem {
	content?: string;
	parent_tool_use_id?: string;
}

export interface ThinkingItem {
	content?: string;
	full_reasoning?: string;
	redacted?: boolean;
	duration_ms?: number;
	parent_tool_use_id?: string;
}

export type ToolItemStatus =
	| "running"
	| "awaiting_permission"
	| "background"
	| "succeeded"
	| "failed"
	| "interrupted"
	| "denied"
	| "expired";

/** `projection.Permission`. */
export interface ToolPermission {
	request_id: string;
	suggestions?: Wire.PermissionUpdate[];
	decision_reason?: string;
	blocked_path?: string;
	seq?: HistorySeq;
	status: "pending" | "allowed" | "denied" | "expired";
	choice?: Wire.PermissionChoiceName;
	by?: Wire.PermissionResponder;
	review?: Wire.PermissionReview;
	always?: boolean;
	answered_at?: string;
	reason?: Wire.CancelReason;
}

/** `projection.Result`. */
export interface ToolResult {
	text?: string;
	contents?: unknown;
	is_error?: boolean;
	subtype?: string;
	duration_ms?: number;
	exit_code?: number;
	subagent?: Wire.SubagentReport;
	html_page?: string;
	work_ref?: Wire.WorkRef;
	observed_at?: string;
	seq?: HistorySeq;
}

export interface PlanItem {
	steps?: Wire.PlanStep[];
	explanation?: string;
	plan_id?: string;
	tool_use_id?: string;
	parent_tool_use_id?: string;
}

export interface ToolItem {
	tool_use_id?: string;
	tool_name?: string;
	tool_input?: unknown;
	parent_tool_use_id?: string;
	origin_tool_use_id?: string;
	status: ToolItemStatus;
	started_at?: string;
	ended_at?: string;
	permission?: ToolPermission;
	result?: ToolResult;
	backgrounded?: boolean;
	placeholder?: string;
	lost_with_process?: boolean;
	finished_after_stop?: boolean;
	plan?: PlanItem;
	/** On pages only: an update never carries a run's children. */
	children?: PageItem[];
}

/** `projection.Question`. */
export interface QuestionItem {
	request_id: string;
	header?: string;
	question: string;
	options?: Wire.QuestionOption[];
	multi_select?: boolean;
	asked_at?: string;
	legacy?: boolean;
	tool_use_id?: string;
	status: "open" | "answered" | "declined" | "withdrawn";
	answer?: Wire.QuestionAnswer;
	answered_in?: string;
	/** The answer a Stop threw away unread, which reopened the question. */
	discarded_answer?: Wire.QuestionAnswer;
	discarded_in?: string;
	reason?: Wire.CancelReason;
	resolved_at?: string;
}

export interface ReadItem {
	message_id?: string;
	observed_at?: string;
}

export interface NoteItem {
	content?: string;
}

export interface WarningItem {
	message?: string;
	code?: string;
	auth_failure?: Wire.AuthFailure;
	usage_limit?: Wire.UsageLimit;
}

export interface ErrorItem {
	error?: string;
	auth_failure?: Wire.AuthFailure;
	usage_limit?: Wire.UsageLimit;
	observed_at?: string;
}

/** `projection.PageItem`: one item, its payload under the field named after its kind. */
export interface PageItem {
	/** Absent only on the warning standing in for a record nobody could write. */
	id?: number;
	kind: ItemKind;
	seq?: HistorySeq;
	last_seq?: HistorySeq;
	message?: MessageItem;
	text?: TextItem;
	thinking?: ThinkingItem;
	tool?: ToolItem;
	question?: QuestionItem;
	plan?: PlanItem;
	read?: ReadItem;
	system?: NoteItem;
	warning?: WarningItem;
	error?: ErrorItem;
	raw?: NoteItem;
	command_output?: NoteItem;
}

/** `projection.Page`. */
export interface ChatPage {
	turns: PageTurn[];
	has_more: boolean;
	next_before_seq?: HistorySeq;
	through_seq?: HistorySeq;
	plan?: PageItem;
	/** The server's clock as it built the reply (RFC 3339). */
	server_time?: string;
}

/** `rpc.ThinkingStream`. */
export interface ThinkingStream {
	content?: string;
	full_reasoning?: string;
}

/** `rpc.ToolStream`. */
export interface ToolStream {
	activity?: string;
	output?: string;
	output_truncated?: boolean;
	subagent_progress?: Wire.SubagentProgress;
}

/** `rpc.ChatStreams`. */
export interface ChatStreams {
	thinking?: ThinkingStream;
	tools?: Record<string, ToolStream>;
}

export interface TurnUpdate {
	turn: ChatTurn;
	discarded?: DiscardedMessage[];
}

export interface ItemUpdate {
	turn_id?: string;
	parent?: number;
	item: PageItem;
}

export interface StreamsEnded {
	thinking?: boolean;
	tools?: string[];
}

/** `chat.update`, its subscription id taken off. */
export interface ChatUpdate {
	type: "update";
	through_seq?: HistorySeq;
	turns?: TurnUpdate[];
	items?: ItemUpdate[];
	plan?: PageItem;
	streams_ended?: StreamsEnded;
}

/** `chat.delta`, its subscription id taken off. */
export interface ChatDelta {
	type: "delta";
	thinking?: ThinkingStream & { replace?: boolean };
	tool?: ToolStream & { tool_use_id: string; replace?: boolean };
}

/**
 * `chat.resync`: the server could not tell this subscription something, and
 * sends nothing more on it. The client subscribes afresh.
 */
export interface ChatResync {
	type: "resync";
}

export type ChatNotification = ChatUpdate | ChatDelta | ChatResync;
