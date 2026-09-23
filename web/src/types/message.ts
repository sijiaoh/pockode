import type { AuthCredentialParams } from "@pockode/shared";
import type { ContentBlock } from "./content";
import type { AgentType } from "./settings";
import type { WorkType } from "./work";

export type SessionMode = "default" | "yolo";

/**
 * Where a forked session came from. Only the parent's id: the client resolves
 * it against the session list it already holds, and a parent that list has no
 * row for is named by `UNLISTED_SESSION_NAME` rather than claimed to be gone.
 * Copying the title here instead would keep showing the old one after a rename.
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
 * Three fields are also on `SessionDetail`, and none of them can drift: `turn`
 * and `forked_from` are read straight off the session the server stores, so the
 * row and the detail are two narrowings of one record rather than two accounts
 * of it, and `work_id` is stored on neither — each side derives it from the work
 * item that names this session.
 */
export interface SessionListItem {
	id: string;
	title: string;
	/**
	 * The work item this session runs, absent on a plain chat session. It is both
	 * the row's link to the work page and the whole of what tells a client the
	 * session belongs to work — the question used to be answered by inverting the
	 * work list, which made this list wrong for as long as that one was
	 * incomplete (docs/code/subscription-system.md#which-sessions-belong-to-work).
	 */
	work_id?: string;
	/** The row's subtitle, and what the list is ordered by. */
	updated_at: string;
	/**
	 * What the session is doing, whole. Everything the row draws is derived from
	 * it by `sessionActivity` (web/src/lib/activity.ts) — nothing here is read
	 * field by field, which is the rule this shape exists to make possible.
	 */
	turn: SessionTurn;
	unread: boolean;
	/**
	 * How many questions this session is waiting on an answer to. The count and
	 * not the list: thirty rows do not need thirty question texts to draw thirty
	 * glyphs, and the list itself rides on `turn` for the one session that is
	 * open. Absent means none.
	 */
	unanswered_questions?: number;
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
 * One fetch of an earlier call's output, recorded on the call it read.
 *
 * Keyed by the fetching call's own `tool_use_id`, never simply appended: a
 * history page replayed over a transcript that already holds it sends the same
 * `tool_result` a second time, and appending would draw that one fetch twice.
 */
export interface ToolFetch {
	/** The `tool_use_id` of the call that fetched this. */
	id: string;
	/**
	 * What came back, under the same two names a run's own outcome uses and read
	 * the same way — `contents` when it is there, `result` otherwise
	 * (`toolRunText`). Naming them anything else here would be a second spelling
	 * of one rule, and a reader who checked `result` alone would report an image
	 * as an empty fetch.
	 *
	 * Both absent is the third case and a real one: the fetch never returned,
	 * because the turn was cut short. An empty `result` means it returned and
	 * had nothing to say, which is a different sentence.
	 */
	result?: string;
	contents?: ContentBlock[];
	/** The fetch failed. Says nothing about the task it was trying to read. */
	isError?: boolean;
}

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
	 * What later calls fetched back of this call's task, oldest first (Claude's
	 * `TaskOutput`). Derived from persisted `tool_result` records, unlike
	 * `activity` and `output`, so a replayed run still has it.
	 *
	 * Kept apart from `result`: that is this call's own outcome, handed to the
	 * agent when the call returned, while a fetch is a second call reading the
	 * task afterwards. Folding one into the other would assert the agent saw
	 * something it never did.
	 */
	fetches?: ToolFetch[];
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

/**
 * Why a card stopped waiting for its answer (docs/lifecycle-ui.md §5). One type
 * for both card kinds, because "why did this stop waiting for me" is one
 * question — but no reason reaches both, and each card draws only the ones that
 * can reach it:
 *
 * | Reason | Reaches | Written by |
 * |---|---|---|
 * | `process_ended` | a permission card | the process going away |
 * | `timeout` | a permission card | the answer lease running out |
 * | `work_closed` | either | the work layer retiring a closed work's session |
 * | `step_done` | a question card | a step being completed while the question waited |
 *
 * Absent is a real answer and the common one: a turn that simply ended, or a
 * user who sent a message instead of answering, leaves a card nothing can
 * answer for a reason the server cannot name. The banner then says what is true
 * of all of them rather than guessing.
 */
export type ExpiryReason =
	| "process_ended"
	| "timeout"
	| "work_closed"
	| "step_done";

export type PermissionStatus = "pending" | "allowed" | "denied" | "expired";

/**
 * How a posted question stands, derived by the reducer from the records that
 * name its `request_id` (docs/answering-ui.md §6).
 *
 * There is no `expired`: a posted question belongs to the session, not to the
 * process that asked it, so a process ending is not an ending for the question.
 */
export type QuestionRecordStatus =
	| "pending"
	| "answered"
	| "declined"
	| "cancelled";

/** The `question_posted` record: what was asked, and when. */
export interface QuestionRecord {
	requestId: string;
	question: AskUserQuestion;
	/** Absent on a record written without one; see the server's `asked_at`. */
	askedAt?: string;
}

export type ContentPart =
	| { type: "text"; content: string }
	| { type: "tool_call"; tool: ToolRun }
	| { type: "system"; content: string }
	| { type: "warning"; message: string; code: string }
	| {
			type: "permission_request";
			request: PermissionRequest;
			status: PermissionStatus;
			/** Only ever set alongside `expired`; see ExpiryReason. */
			reason?: ExpiryReason;
	  }
	| {
			/**
			 * The record of a question the agent posted through `question_post`.
			 * A record and nothing more: it holds no form and no live state, and
			 * whether the question is still open is the turn's answer, not this
			 * card's (docs/answering-ui.md §6).
			 */
			type: "question_record";
			record: QuestionRecord;
			status: QuestionRecordStatus;
			/** What was said back. Set on `answered` and `declined`. */
			answer?: QuestionAnswerRecord;
			/** Absent reason on a `cancelled` card means the agent withdrew it. */
			reason?: ExpiryReason;
			/**
			 * Set on a card read from an `ask_user_question` record: the CLI's own
			 * blocking question, from a transcript written before Pockode stopped
			 * letting a CLI ask one.
			 *
			 * It renders as a record like any other, and an answered one even fills
			 * its form in, but a `pending` one can never be answered — the process
			 * that was holding the tool call open is long gone — so the card says so
			 * instead of offering a way in.
			 */
			legacy?: boolean;
	  }
	| { type: "raw"; content: string }
	| { type: "command_output"; content: string };

/**
 * Origin of a message: user-typed, Pockode's own system automation, or another
 * agent putting something into this session. Absent/`"user"` = a normal user
 * message (backward compatible with old history).
 *
 * `"agent"` is today only an answer given through `question_answer`. It is
 * neither of the other two: a user bubble would claim the person said it, and
 * the system line would read as Pockode's own annotation. Who answered is on
 * the answer itself (`QuestionAnswerRecord.resolved_by`).
 */
export type MessageOrigin = "user" | "system" | "agent";

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
	/**
	 * The posted questions this message answers, when it answers any. The bubble
	 * is drawn from these rather than from `content`, which is the same facts
	 * flattened for the agent to read (docs/answering-ui.md §3).
	 */
	answering?: QuestionAnswerRecord[];
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
	/**
	 * This bubble was opened by a read point — the agent had just picked up the
	 * message above it — rather than by content that belonged nowhere else.
	 *
	 * Read by `prependHistoryPage` alone, and it exists because a page of history
	 * can begin at a read point: the page then opens on a bubble no message event
	 * preceded, which is also the shape of a turn cut in half by the page size,
	 * and those two must not be joined back together. Nothing renders it.
	 */
	openedAtReadPoint?: true;
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
	/**
	 * Optional: a live question omits it when the agent gave none
	 * (`session.QuestionOption`), while a record from the CLI's own prompt
	 * always carries the key and may carry an empty string. Both mean the same
	 * thing to a reader, so neither draws a line.
	 */
	description?: string;
}

export interface AskUserQuestion {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

/**
 * One question an agent posted and nobody has answered yet.
 *
 * It is *state*, not a record: it rides on the session's turn, arrives with
 * every subscription that carries one, and disappears the moment the question
 * is resolved. The card in the transcript is the immutable half of the same
 * event and is never read to find out whether a question is still open
 * (docs/answering-ui.md §1).
 *
 * One `question_post` is one question and one `request_id`, which is what makes
 * "decline this one" a sentence with a subject.
 */
export interface PendingQuestion {
	request_id: string;
	/** The short label the agent gave it; the chip on every surface. */
	header: string;
	question: string;
	/** Empty means free text — the shape `work_needs_input` took. */
	options?: QuestionOption[];
	multi_select?: boolean;
	asked_at: string;
}

/**
 * Who answered a question (`QuestionAnswerRecord.resolved_by`).
 *
 * `work_id` and `title` are the *answering* work, copied into the record for
 * the same reason the header and the question are: the reader is a bubble in
 * someone else's transcript, and that work is not one it can look up. Both are
 * absent for a user, and for an agent running in a session no work owns.
 */
export interface QuestionResolver {
	kind: "user" | "agent";
	work_id?: string;
	title?: string;
}

/**
 * One question a message answered, as the message record carries it.
 *
 * `header` and `question` travel with the answer rather than being resolved
 * from the question's own record: the bubble is drawn from this alone, and the
 * card that asked may be thousands of records back — outside every page this
 * client will ever load.
 */
export interface QuestionAnswerRecord {
	request_id: string;
	header?: string;
	question?: string;
	/**
	 * The option labels picked, and only ever labels the question offered. Empty
	 * when the user answered in their own words, and when declined.
	 */
	answers?: string[];
	/**
	 * What the user wrote themselves: the whole answer to a question that offered
	 * no options, or the **Other** beside ones it did.
	 *
	 * Apart from `answers` because the agent has to be able to tell them apart —
	 * a label is its own word handed back, this is the user's. That is also why
	 * the server checks one against the question and never the other.
	 */
	text?: string;
	declined?: boolean;
	/** The optional line the user added beside a decline. */
	note?: string;
	/**
	 * Who gave this answer. Absent on records written before an agent could
	 * answer at all, which were all the user's — so absent reads as the user,
	 * and every record written now says which it is outright.
	 */
	resolved_by?: QuestionResolver;
	answered_at: string;
}

/**
 * One question answered by a `chat.message`, as the client states it.
 * Either `declined`, or something in `answers` or `text`.
 */
export interface QuestionAnswerParams {
	request_id: string;
	answers?: string[];
	text?: string;
	declined?: boolean;
	note?: string;
}

// JSON-RPC 2.0 Request Params (Client → Server)

/** The credential (see `AuthCredentialParams`) plus the worktree to bind to. */
export interface AuthParams extends AuthCredentialParams {
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
	/**
	 * What the client stores in place of the password: freshly issued when it
	 * authenticated with a password, and the very same token it sent when it
	 * authenticated with one. Never a rotation, so it can be stored
	 * unconditionally without tracking how the connection logged in.
	 */
	session_token: string;
}

export interface MessageParams {
	session_id: string;
	content: string;
	/**
	 * The posted questions this message answers. The server validates every
	 * entry against the session's live list before delivering anything and
	 * refuses the whole message with `-32602` naming the ones that are no longer
	 * pending — the body is one string, so there is no half of it to deliver.
	 */
	answering?: QuestionAnswerParams[];
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

/**
 * How far a page of the session list reaches, and what the rest of the list is
 * doing.
 *
 * `next_cursor` is opaque: it names the position the next page starts at, and
 * is handed back unread. It is absent exactly when `has_more` is false — asking
 * for more must mean "the sessions after this one" and never "skip the first
 * N", because the list is sorted by `updated_at` and that moves while the user
 * scrolls (docs/list-paging-ui.md §3.3).
 */
export interface SessionListPage {
	sessions: SessionListItem[];
	next_cursor?: string;
	has_more?: boolean;
}

export interface SessionListSubscribeResult extends SessionListPage {
	/**
	 * Whether anything in the *whole* list is unread, never just the page. The
	 * sidebar's tab badge is an "is there any", and a page cannot answer that: an
	 * unread session is one an agent finished with while nobody was looking,
	 * which is exactly the session nobody has scrolled to
	 * (docs/list-paging-ui.md §2.1).
	 */
	has_unread: boolean;
}

export type SessionListPageResult = SessionListPage;

export type SessionListChangedNotification =
	| {
			id: string;
			operation: "create" | "update";
			session: SessionListItem;
			/** Absent when the server could not read it; keep the last answer. */
			has_unread?: boolean;
	  }
	| { id: string; operation: "delete"; sessionId: string; has_unread?: boolean }
	| ({
			id: string;
			operation: "sync";
			has_unread?: boolean;
	  } & SessionListPage);

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
	 * The work item this session runs, absent on a plain chat session — the same
	 * field `SessionListItem` carries, and the reason it is on both is the
	 * sidebar filter: it hides exactly the sessions that have one, so the open
	 * session usually has no row to read it off
	 * (docs/code/subscription-system.md#which-sessions-belong-to-work).
	 */
	work_id?: string;
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
/**
 * The two things a turn can be stuck on.
 *
 * A question an agent posts is deliberately not one of them: it belongs to the
 * session, outlives every process and every turn, and blocks nothing — the agent
 * carries on working. It rides on `SessionTurn.unanswered` instead.
 */
export type TurnBlockerKind = "permission" | "background";

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
	/**
	 * The questions this session has asked and nobody has answered yet, oldest
	 * first. Deliberately not a blocker: it does not affect `phase`, it survives
	 * every process ending, and the composer is not disabled for it — the agent
	 * asked and carried on (docs/answering-ui.md §1).
	 */
	unanswered?: PendingQuestion[];
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
	| "question_posted"
	| "request_cancelled"
	| "system"
	| "message"
	| "message_ingested"
	| "command_output";

export type ServerNotification =
	| { type: "text"; content: string }
	| {
			type: "message";
			content: string;
			origin?: MessageOrigin;
			subtype?: string;
			meta?: SystemMessageMeta;
			/** The posted questions this message answers; see QuestionAnswerRecord. */
			answering?: QuestionAnswerRecord[];
	  }
	| {
			type: "tool_call";
			tool_name: string;
			tool_input: unknown;
			tool_use_id: string;
			/**
			 * The earlier call this one is about, when the input can only name it
			 * by something else: Claude's `TaskOutput` fetches a task's output by
			 * `task_id`, and only the adapter can turn that into a `tool_use_id`.
			 * Absent whenever it could not be resolved, which is ordinary — such a
			 * call simply stands alone. See docs/tool-call-model.md.
			 */
			origin_tool_use_id?: string;
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
			/**
			 * A question the agent posted through `question_post`. One question per
			 * record; `questions` is a one-element list so a client draws it with
			 * the same renderer the CLI's own prompt uses.
			 */
			type: "question_posted";
			request_id: string;
			questions: AskUserQuestion[];
			/** Absent on a record written without one. */
			asked_at?: string;
	  }
	| {
			type: "request_cancelled";
			request_id: string;
			/**
			 * Absent when the agent withdrew the request itself: the CLI said it no
			 * longer needs an answer and did not say why.
			 */
			reason?: ExpiryReason;
			/**
			 * When the withdrawal happened. Absent on a cancellation forwarded from
			 * a CLI, which does not timestamp them.
			 */
			resolved_at?: string;
	  }
	| { type: "system"; content: string }
	| {
			/**
			 * The agent has read a message that was sent into a turn already
			 * running — the read point (agent-integration.md#the-read-point). It
			 * says nothing itself; it is a boundary, and everything the agent
			 * writes after it answers the message rather than the one before it.
			 *
			 * Written only for a message that arrived mid-turn: the one that opens
			 * a turn has nothing above it to cut away.
			 *
			 * `message_id` names the message that was read. The transcript
			 * deliberately does not place the new bubble by it and cuts by the
			 * record's position instead, which is the same answer without the id
			 * (docs/code/frontend-state.md); it is declared here because a reader
			 * of this record will ask what became of it.
			 */
			type: "message_ingested";
			message_id?: string;
	  }
	| { type: "command_output"; content: string };
