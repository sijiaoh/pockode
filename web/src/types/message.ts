import type { AppAuthCredentialParams } from "../lib/loginTicket";
import type { ChatPage, ChatStreams, ChatUpdate } from "./chatItems";
import type { ContentBlock, FileBlock } from "./content";
import type { AgentType } from "./settings";
import type * as Wire from "./wire.generated";
import type { WorkType } from "./work";

/** The modes this build knows, and the only ones it ever sends. */
export type SessionMode = "default" | "yolo" | "unattended";

/**
 * A mode as the server reports it. A newer server may report one this build
 * has never heard of; it is shown by its raw id rather than mistaken for a
 * known one (`getSessionModeInfo`).
 */
export type ReportedSessionMode = SessionMode | (string & {});

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
	/**
	 * How many active stories this session watches and would be woken by
	 * (a session whose own work is not active is woken by none), counted by the
	 * server — a client holding a paged work list cannot count what it was never
	 * sent (docs/lifecycle-ui.md §1.2). Absent means none. The third input of
	 * `sessionActivity`, beside the turn and the work's wait.
	 */
	watching?: number;
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
	/**
	 * `SessionDetail.html_first`, on the row because the row draws it
	 * (docs/html-first-session-ui.md §3). Absent means an ordinary chat.
	 */
	html_first?: boolean;
	/**
	 * The main session this session is the permission reviewer of, absent on
	 * every other session. Fixed at the reviewer's creation
	 * (docs/unattended-mode.md#the-permission-reviewer-session).
	 */
	permission_reviewer_of?: string;
}

/** One story a session watches: enough to list it and open its detail. */
export interface WatchedStory {
	id: string;
	title: string;
}

/**
 * One history record's address: unique and increasing within the session, not
 * promised to be dense, assigned by the server and only ever quoted back. Never
 * counted client-side — some records are written without being broadcast, so a
 * local counter drifts and a fork would then cut in the wrong place
 * (docs/session-fork-ui.md) — and never computed with: there can be gaps.
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
 * How one tool call stands right now, as the row draws it: the server's item
 * status (`ToolItemStatus`) read onto the row's five
 * (docs/tool-call-model.md#toolrun). A call waiting on permission, or refused
 * or expired before it ran, is drawn as its card instead.
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

export type PlanStepStatus = Wire.PlanStepStatus;

/** One item of a plan the agent wrote (docs/turn-progress-ui.md#46-the-plan-record). */
export interface PlanStep {
	/** The CLI's task id; only a step from Claude's Task-tool fold has one. */
	id?: string;
	text: string;
	/** Claude's `activeForm`: the words for the item while it is in progress. */
	activeText?: string;
	status: PlanStepStatus;
}

/**
 * The plan as one `plan` record said it was at that moment: the newest one by
 * `order` is the current plan.
 */
export interface ToolRunPlan {
	steps: PlanStep[];
	/** Codex's note on the plan, when it gave one. */
	explanation?: string;
	/**
	 * Where the plan stands in record order, which is what "newest" means
	 * (docs/turn-progress-ui.md#46-the-plan-record): the seq of the item that
	 * carries it — a Codex plan's own, or the newest record of the call it was
	 * filed on.
	 */
	order: number;
}

/**
 * One fetch of an earlier call's output, drawn on the call it read: the
 * fetching call's own item, filed there by its `origin_tool_use_id`.
 */
export interface ToolFetch {
	/** The `tool_use_id` of the call that fetched this. */
	id: string;
	/**
	 * `running` until its result arrives; `interrupted` when what ends a
	 * running call ended it first — a result reaching it after that is kept but
	 * does not make it `returned`.
	 */
	state: "running" | "returned" | "interrupted";
	/**
	 * The fetch waits for the task to finish (`block` not false) rather than
	 * reading at once. Only chooses a word.
	 */
	waits: boolean;
	/** The fetch's start on this client's clock, read as `ToolRun.seenAt` is. */
	seenAt?: Date;
	/**
	 * What came back, under the same two names a run's own outcome uses and read
	 * the same way — `contents` when it is there, `result` otherwise
	 * (`toolRunText`). Naming them anything else here would be a second spelling
	 * of one rule, and a reader who checked `result` alone would report an image
	 * as an empty fetch.
	 *
	 * Both absent while the fetch is running, and on one that never returned
	 * because the turn was cut short. An empty `result` means it returned and
	 * had nothing to say, which is a different sentence.
	 */
	result?: string;
	contents?: ContentBlock[];
	/** The fetch failed. Says nothing about the task it was trying to read. */
	isError?: boolean;
}

/**
 * An engine's own counters of a subagent's work: live on `subagentProgress`,
 * final on `subagent`, kept as the engine gave them. A row counts its own
 * children wherever it has any and reads `toolUses` only where it has none
 * (`subagentToolUses`). Absent means the engine did not say; 0 is a figure.
 */
export interface SubagentCounts {
	/** How many tool calls the subagent made in this call (not a resume's). */
	toolUses?: number;
	/**
	 * The subagent's context at its latest request — that request's input,
	 * cache and output tokens — not what the whole run spent.
	 */
	totalTokens?: number;
}

/**
 * What was true of a subagent when its call's result was written — a fact of
 * that moment, from the `tool_result` record's `subagent`. Its duration is
 * the run's `durationMs`, where every call's is.
 */
export interface SubagentReport extends SubagentCounts {
	/** The engine's id for the subagent, which resuming it takes. */
	agentId?: string;
	/** Which agent it was: Claude's subagent type, Codex's agent path. */
	agentType?: string;
}

/** How far a running subagent has come, from its call's stream. Live state. */
export interface SubagentProgress extends SubagentCounts {
	/** The tool it called most recently. */
	lastToolName?: string;
}

/**
 * A work item as it was when a Pockode work tool acted on it: the server's
 * `work_ref` stamp (docs/tool-call-model.md#a-call-on-pockodes-own-work). The
 * title is the one it had then, and there is deliberately no status.
 */
export interface WorkRef {
	id: string;
	type: WorkType;
	title: string;
}

/**
 * One tool call and everything known about it, subagent calls included: a Task
 * *is* a tool call, and keeping a second shape for it meant two status
 * machines and two settle-on-interrupt paths for one thing. `TaskItem` stays,
 * as the renderer for that category.
 *
 * Built from the call's item by the transcript (lib/transcript.ts), which is
 * its only author. A renderer switches on `status` and infers nothing of its
 * own.
 */
export interface ToolRun {
	id: string;
	name: string;
	/** Complete, never truncated: the row's summary is derived from it. */
	input: unknown;
	status: ToolRunStatus;
	/**
	 * The latest one-line status of a call still running. Live state: it comes
	 * from the call's stream (`chat.delta`), which is never persisted, so a run
	 * read from history has none and is still correct — `status` is what
	 * carries "still going".
	 */
	activity?: string;
	/**
	 * How far a running subagent has come. Live state, like `activity`: gone
	 * once the run settles, when `subagent` is what is true.
	 */
	subagentProgress?: SubagentProgress;
	/**
	 * What its result said about the subagent the call ran. A backgrounded
	 * one's placeholder names it (`agentId`); its outcome carries the whole
	 * report. Absent for any other call, and on records from before it existed.
	 */
	subagent?: SubagentReport;
	/** A running call's output so far, accumulated from the deltas. Live state. */
	output?: string;
	/**
	 * How many first lines `output` has lost to the transcript's cap, so a reader
	 * of it can tell where its lines sit in the whole.
	 */
	outputDroppedLines?: number;
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
	 * Set on an `interrupted` run whose result arrived after the interrupt and
	 * was not an error: the engine let the call run on, and it finished. The
	 * status stays `interrupted` — that is what the turn did to it — and the
	 * row draws it as the success it was (docs/tool-call-ui.md#status). An
	 * error result is not enough to set it: Claude's own report of the cut is
	 * one, and so is a command the engine actually killed.
	 */
	finishedAfterStop?: boolean;
	/**
	 * The answer this call waited on, carried over from the permission card
	 * that stood in the row's place: an answered card hands its place back to
	 * the row, and this is all of the card the row keeps
	 * (docs/tool-call-ui.md#the-permission-card-takes-the-rows-place).
	 */
	permission?: ToolRunPermission;
	/**
	 * Its backgrounded work died with the CLI process running it (a
	 * `process_ended` under it, or Pockode's `background_lost`). Nothing
	 * returned: a `result` it carries is Pockode's account of the loss, not the
	 * work's own outcome, so a row must not present it as one that came back.
	 */
	lostWithProcess?: boolean;
	/**
	 * What later calls fetched back of this call's task, oldest first (Claude's
	 * `TaskOutput`). Persisted, unlike `activity` and `output`, so a run read
	 * from history still has it.
	 *
	 * Kept apart from `result`: that is this call's own outcome, handed to the
	 * agent when the call returned, while a fetch is a second call reading the
	 * task afterwards. Folding one into the other would assert the agent saw
	 * something it never did.
	 */
	fetches?: ToolFetch[];
	/**
	 * The plan this call left, from the `plan` record its result produced
	 * (Claude's `TodoWrite` and Task tools, Codex's `Plan` row).
	 */
	plan?: ToolRunPlan;
	/**
	 * The earlier call this one is about, from its record's
	 * `origin_tool_use_id` — kept only on a call that keeps its own row while
	 * naming another: a stop of a background task (`TaskStop`), whose body
	 * points at the work it stopped. A fetch with an origin is filed under that
	 * call instead, and has no row to carry it.
	 */
	originToolUseId?: string;
	/**
	 * How long the call took, when the engine reported it as a figure (Codex
	 * for commands and MCP calls, Claude for only a few tools). Only ever the
	 * engine's: what Pockode observed is
	 * `startedAt` / `endedAt`, and `toolRunDurationMs` decides between them.
	 */
	durationMs?: number;
	/**
	 * When the call started running, on the server's clock (epoch ms): its
	 * `tool_call`'s `observed_at`, or — for a call that waited on a permission
	 * card — that of the answer that let it run, which is later. Absent when
	 * that moment was not observed: a record from before the stamps, or an
	 * answer that carries none (counting from the call would count the user's
	 * wait).
	 */
	startedAt?: number;
	/**
	 * When the call settled, on the server's clock (epoch ms): the `observed_at`
	 * of the `tool_result` that settled it — for a backgrounded call the
	 * outcome, never the placeholder. Never the turn's or the process's ending:
	 * those say when Pockode gave up on the call, not when it finished.
	 */
	endedAt?: number;
	/** The command's exit status, when the engine reports one separately. */
	exitCode?: number;
	/**
	 * The page a successful page tool stored (`p3`), from its result's
	 * `html_page`. Absent on any other call, and on an `html_render` from before
	 * pages were stored.
	 */
	htmlPage?: string;
	/**
	 * The work item a successful Pockode work tool acted on, as it was when the
	 * call was made — from its result's `work_ref`. An event's: it never
	 * carries a status, which is the work store's, read by `id`. Absent on any
	 * other call, on a failed one, and on records from before it existed.
	 */
	workRef?: WorkRef;
	/**
	 * When the call started, on this client's clock — what a live counter counts
	 * from. The moment the start arrived, when this client watched it arrive;
	 * otherwise `startedAt` carried over from the server clock reading its
	 * history came with. Absent when neither is known, and then no counter is
	 * drawn: a server time subtracted from this clock would show drift as work.
	 */
	seenAt?: Date;
	/**
	 * A subagent call's own text and calls, in arrival order — the same shape a
	 * message's content is: the items nested in the call's item. Absent for every call
	 * that is not a subagent's, and for a subagent from a transcript recorded
	 * before records named their parent (docs/tool-call-model.md#a-subagents-own-conversation).
	 */
	children?: ContentPart[];
}

/** What a run keeps of the permission card it took back its place from. */
export interface ToolRunPermission {
	answer: "allowed" | "denied";
	/** As on the card: absent for a person's answer. */
	by?: PermissionAnswerer;
	review?: PermissionReview;
	/** The answer was Always Allow. */
	always?: boolean;
	/** What Always Allow wrote: the suggestions the request carried. */
	suggestions?: PermissionUpdate[];
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
export type ExpiryReason = Wire.CancelReason;

export type PermissionStatus = "pending" | "allowed" | "denied" | "expired";

/**
 * Who answered a permission request in a person's place: the session's
 * permission reviewer, or Pockode denying it itself when the review fell
 * through. Absent is a person. A newer server may name one this build does not
 * know; it is kept as sent (docs/agent-event.md#permission-requests-and-their-answers).
 */
export type PermissionAnswerer = Wire.PermissionResponder | (string & {});

/** The `review` of a `permission_response` a reviewer or Pockode gave. */
export interface PermissionReview {
	/** The reviewer session. Absent when the review failed before one existed. */
	sessionId?: string;
	/** Why the reviewer denied it; on a reviewer's deny only. */
	category?: string;
	/** Why Pockode denied it itself; on a `pockode` deny only. */
	automatic?: string;
	/** The reviewer's own words, or Pockode's account. Model output: plain text. */
	reason?: string;
}

/**
 * How a posted question stands, as the server's question item says
 * (docs/answering-ui.md §6).
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

/** One `thinking` record, as a thinking row draws it. */
export interface Thought {
	/**
	 * Its key within its row: its item's part id (`ChatItems.partIds`). Not its
	 * position: a page joining
	 * from above puts the older half's thoughts in front of the newer half's.
	 */
	id: string;
	/** Claude's thinking, or Codex's reasoning summary; Markdown. */
	content: string;
	/** Codex's raw reasoning, drawn under its own label beside `content`. */
	fullReasoning: string;
	redacted: boolean;
	/** Measured by the server; absent when nothing measured it. */
	durationMs?: number;
}

/**
 * One piece of an assistant message's content.
 *
 * `id` is the part's identity, which every list keys it by. Minted by the
 * store the first time its item is seen, since an item id is not a key the
 * list can sort by, and
 * a part must keep its key while the parts around it change: a history page
 * joining from above puts parts in front of it, and an index would hand its DOM
 * and state to whichever part slid into its place. A part rewritten in place
 * keeps it, and a card that takes a row's place takes the row's. Ids sort in
 * the order they were minted — see `newPartId`.
 */
export type ContentPart = { id: string } & (
	| {
			type: "text";
			content: string;
			/**
			 * Set only on a subagent's text that could not be filed under its call
			 * because the call is not in the history at all (a fork cut it off); it
			 * then sits flat where it arrived. Filed children carry none — where
			 * they sit already says whose they are.
			 */
			parentToolUseId?: string;
	  }
	| {
			type: "tool_call";
			tool: ToolRun;
			/** See the `text` part. */
			parentToolUseId?: string;
	  }
	| {
			/**
			 * A run of consecutive `thinking` records, drawn as one row
			 * (docs/turn-progress-ui.md#11-what-it-is): the engine splitting one
			 * pause into two blocks is nothing the reader can use. Never empty.
			 */
			type: "thinking";
			thoughts: Thought[];
			/** See the `text` part. */
			parentToolUseId?: string;
	  }
	| { type: "system"; content: string }
	| {
			type: "warning";
			message: string;
			code: string;
			/**
			 * The CLI and account that were refused for their credentials, when
			 * the warning says so — a retry the turn is still making. A record of
			 * that moment, never whether the CLI is signed in now
			 * (docs/cli-login-ui.md).
			 */
			authFailure?: RecordedAccount;
			/** The CLI and account that hit a usage limit; see `RecordedAccount`. */
			usageLimit?: RecordedAccount;
	  }
	| {
			type: "permission_request";
			request: PermissionRequest;
			status: PermissionStatus;
			/** Only ever set alongside `expired`; see ExpiryReason. */
			reason?: ExpiryReason;
			/**
			 * Who gave the answer, from its `permission_response` record; absent for
			 * a person's. History, not live state: whether the request is under
			 * review right now is the session's turn's (`TurnBlocker.reviewing`).
			 */
			by?: PermissionAnswerer;
			/** Set with `by`. */
			review?: PermissionReview;
			/** The answer was Always Allow, from its `permission_response` record. */
			always?: boolean;
			/**
			 * The server has recorded the answer. Before that an allowed card is a
			 * press on its way.
			 */
			answerRecorded?: boolean;
			/**
			 * When the answer was given, on the server's clock (epoch ms), and on
			 * this client's; the start of the call the row that takes this card's
			 * place runs (`ToolRun.startedAt` / `seenAt`). Absent when not known.
			 */
			answeredAt?: number;
			answerSeenAt?: Date;
			/** Carried over from the flat row it took the place of; see `text`. */
			parentToolUseId?: string;
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
			/**
			 * A Stop threw `answer` away before the agent read it, and the question
			 * is open again: the server's item keeps the answer it lost
			 * (`discarded_answer`) until a new answer or a withdrawal replaces it
			 * (docs/answering-ui.md §6).
			 */
			unread?: boolean;
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
			/** As on `permission_request`. */
			parentToolUseId?: string;
	  }
	| { type: "raw"; content: string }
	| { type: "command_output"; content: string }
);

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
export type MessageOrigin = Wire.MessageOrigin;

/**
 * The account the CLI that produced a record ran as: the cliprofile id, `""`
 * for the default account. Absent on records kept before accounts were
 * recorded, whose account is unknown. Only the id; the name is looked up.
 */
type RecordedProfileId = string;

/**
 * A CLI and the account it ran as, as a record names them: a fact about that
 * moment. Which account is current now, and its name, are read from the
 * profile list when drawn — never from here (AGENTS.md, "Events are events").
 */
export interface RecordedAccount {
	agent: AgentType;
	/**
	 * `DEFAULT_PROFILE_ID` (`""`) for the default account. Undefined on records
	 * kept before accounts were recorded: the account is unknown, not the
	 * default one.
	 */
	profileId?: RecordedProfileId;
}

/**
 * Summary data for a system-origin message, used to render it without parsing
 * the prompt body.
 */
export type SystemMessageMeta = Wire.MessageMeta;

/**
 * Which prompt a system-origin message is: one of the server's
 * `agent.MessageSubtype` values, or one a newer server added, which is drawn
 * as a plain system message.
 */
export type MessageSubtype = Wire.MessageSubtype | (string & {});

export interface UserMessage {
	id: string;
	role: "user";
	content: string;
	status: MessageStatus;
	createdAt: Date;
	/**
	 * The last history record folded into this message, and so the cut point a
	 * fork anchored here uses: its item's `last_seq`, kept below whatever is
	 * drawn after it. Absent when no record carries one: a record that could not
	 * be persisted, or a message this client sent whose record has not arrived
	 * yet.
	 */
	anchorSeq?: HistorySeq;
	/**
	 * The id the message record carries — what a later record names it by (a
	 * read point, `message_discarded`). Not `id`, which is this client's key
	 * for the row. On the sender's echo it is the id the echo was sent under,
	 * from the first frame; absent on a record written before the field
	 * existed.
	 */
	messageId?: string;
	/** A Stop threw the message away before the agent read it. */
	discarded?: boolean;
	// Present only for system-driven messages; absent means a user-typed message.
	source?: MessageOrigin;
	subtype?: MessageSubtype;
	meta?: SystemMessageMeta;
	/**
	 * The posted questions this message answers, when it answers any. The bubble
	 * is drawn from these rather than from `content`, which is the same facts
	 * flattened for the agent to read — written by the server, and empty on the
	 * sender's echo until its record arrives (docs/answering-ui.md §3).
	 */
	answering?: QuestionAnswerRecord[];
	/**
	 * The Pockode command the user typed, when `content` is the prompt it
	 * expanded to. The row is drawn from this; `content` is what the agent read.
	 */
	command?: PockodeCommandInvocation;
	/**
	 * The files the user sent with the message, each described by its
	 * `attachment_id` through `attachment.get` (a raster image's bytes then
	 * come from `GET /api/chat/attachments`). On the sender's echo these are
	 * what the client knew at send time until its record replaces them with
	 * the server's description (type and dimensions read from the stored
	 * bytes).
	 */
	attachments?: FileBlock[];
	/**
	 * What a page sent, when the message is a page's send rather than typed.
	 * The bubble is drawn from this; `content` is the agent's text, written by
	 * the server and empty on the sender's echo until its record arrives.
	 */
	htmlAction?: HtmlAction;
}

/**
 * A Pockode command as the user typed it: the name without its slash
 * ("pockode-lead") and whatever followed it, absent when nothing did.
 */
export interface PockodeCommandInvocation {
	name: string;
	args?: string;
}

export interface AssistantMessage {
	id: string;
	role: "assistant";
	parts: ContentPart[];
	status: MessageStatus;
	error?: string;
	/**
	 * The CLI and account whose credentials were refused, when `error` is an
	 * auth failure. Absent on errors recorded before the server marked them.
	 */
	authFailure?: RecordedAccount;
	/**
	 * The CLI and account that hit a usage limit, when `error` says so. For
	 * Claude the mark is wider than its name: every rate-limit refusal it gave
	 * up retrying carries it (docs/agent-event.md).
	 */
	usageLimit?: RecordedAccount;
	createdAt: Date;
	/** See `UserMessage.anchorSeq`. */
	anchorSeq?: HistorySeq;
	/**
	 * This bubble was opened by a read point — the agent had just picked up the
	 * message above it — and so continues its turn from the reply above that
	 * message, rather than starting one: what the turn did is read across both
	 * (`openTurnReplies`, `turnWork`).
	 */
	openedAtReadPoint?: true;
	/**
	 * Whatever opened this bubble is on a page not loaded yet: the server said
	 * its turn goes on above the oldest loaded item (a `continued` stretch), and
	 * nothing loaded opened it. Gone once that page joins it.
	 */
	startNotLoaded?: true;
	/**
	 * When this reply began, on the server's clock (epoch ms): the `observed_at`
	 * of the `message` that opened its turn, or of the read point that opened
	 * it. History, like a run's `startedAt` — what the reply's span is measured
	 * from (docs/tool-call-ui.md#where-the-duration-comes-from). Absent when
	 * nothing measured it: a record from before the stamp, or a reply opened
	 * without a message (output the CLI resumed by itself).
	 */
	openedAt?: number;
	/**
	 * When this reply ended, on the server's clock (epoch ms): the `observed_at`
	 * of the next read point, or of the `done` / `interrupted` /
	 * `process_ended` / `error` that ended the turn. Absent while it runs, and
	 * when the ending carried no moment or never came (a reply closed by the
	 * page boundary or by a message opening the next turn).
	 */
	endedAt?: number;
	/**
	 * The messages the Stop that ended this turn threw away unread, by their
	 * `messageId`, in the order the records came. The turn is where the records
	 * stand, and where the summary of what the Stop did is drawn; each message's
	 * own bubble learns its ending by being named here
	 * (docs/discarded-messages-ui.md).
	 */
	discardedMessageIds?: string[];
	/**
	 * The main agent's newest call in this turn is a fetch filed under the run
	 * it reads, still running: the fetch draws no row, so this is what the tail
	 * line reads to say the turn is waiting, and where its `Go to call` goes
	 * (docs/turn-progress-ui.md#23-what-it-says). Read off the open turn's
	 * items: gone once the fetch settles, and once the main agent writes,
	 * thinks or calls again.
	 */
	awaitedFetch?: AwaitedFetch;
}

export interface AwaitedFetch {
	/** The fetching call's `tool_use_id`. */
	id: string;
	/** The run it is filed under, which is where `Go to call` goes. */
	originToolUseId: string;
	/** See `ToolFetch.waits`. */
	waits: boolean;
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
	/**
	 * The option the asking agent would pick itself. Absent means not
	 * recommended: the server omits it when false, and records written before
	 * it existed never carry it. A single-choice question has at most one; a
	 * multi-select may have several. It is a hint to show, never a selection.
	 */
	recommended?: boolean;
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

export type QuestionResolver = Wire.QuestionResolver;

/**
 * One question a message answered, as the message record carries it.
 *
 * `header` and `question` travel with the answer rather than being resolved
 * from the question's own record: the bubble is drawn from this alone, and the
 * card that asked may be thousands of records back — outside every page this
 * client will ever load.
 */
export type QuestionAnswerRecord = Wire.QuestionAnswer;

/**
 * One question answered by a `chat.message`, as the client states it.
 * Either `declined`, or something in `answers` or `text`; `note` beside either,
 * under the rules on {@link QuestionAnswerRecord.note}. The message carrying
 * these has empty `content`: the server writes the text the agent reads.
 */
export interface QuestionAnswerParams {
	request_id: string;
	answers?: string[];
	text?: string;
	declined?: boolean;
	note?: string;
}

// JSON-RPC 2.0 Request Params (Client → Server)

/** The credential (see `AppAuthCredentialParams`) plus the worktree to bind to. */
export interface AuthParams extends AppAuthCredentialParams {
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
	/** False leaves only main in `worktrees`. See WorktreeSubscribeResult. */
	is_git_repo: boolean;
	worktrees: WorktreeInfo[];
	/** Set when creating a worktree would skip the setup script. */
	setup_hook_skip?: SetupHookSkip;
}

/**
 * Whether the project is a git repository, read afresh for the subscriber.
 * worktree.changed carries the same field from then on. While it is false,
 * every git.* request that runs git and worktree create/delete is refused with
 * -32002 (the server's CodeNotGitRepo).
 */
export interface WorktreeSubscribeResult {
	is_git_repo: boolean;
}

export type WorktreeChangedNotification = WorktreeSubscribeResult;

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
	 * The address this server is reachable at through the relay, such as
	 * `https://abc123.cloud.pockode.com`; empty when the relay is disabled or
	 * has stopped for good.
	 */
	remote_url: string;
	/**
	 * Ceiling on one upload request, in bytes, sent so a client can refuse an
	 * oversized file before spending a slow link on it instead of keeping its
	 * own copy of the number. The same on every route — the relay tunnel
	 * streams a request body and imposes no ceiling of its own — but still read
	 * from this reply rather than hard-coded (see docs/file.md#transfer).
	 */
	max_upload_size: number;
	/**
	 * The same ceiling for chat attachments (`POST /api/chat/attachments`),
	 * which have one of their own. Absent from servers that predate them.
	 */
	max_attachment_size?: number;
	/**
	 * The largest raster image the server will serve to be drawn; past it one
	 * is described as `too_large`. Sent for what never reaches the server to
	 * be asked — a file picked in the composer, previewed from its local
	 * `blob:` — so no image is decoded here that the transcript would not draw.
	 * Absent from servers that predate it.
	 */
	max_image_preview_size?: number;
	/**
	 * What the client stores in place of the password: freshly issued when it
	 * authenticated with a password, and the very same token it sent when it
	 * authenticated with one. Never a rotation, so it can be stored
	 * unconditionally without tracking how the connection logged in.
	 */
	session_token: string;
	/**
	 * Names the server process that answered; new every time the server
	 * starts. History seqs are not promised durable — a power loss can drop a
	 * tail already seen, and the restarted server reuses those seqs — so seqs
	 * held from a connection with a different value are to be replaced by a
	 * fresh snapshot, not continued from. Opaque: compare it, never parse it.
	 * Absent from servers that predate it.
	 */
	server_instance?: string;
}

/** What `remote_url.subscribe` replies with; see `AuthResult.remote_url`. */
export interface RemoteUrlSubscribeResult {
	remote_url: string;
}

/**
 * The remote URL moved: renewing the relay credentials put the server on a new
 * subdomain, or remote access ended for good (empty). Carries the URL as it is
 * now, never a delta.
 */
export interface RemoteUrlChangedNotification extends RemoteUrlSubscribeResult {
	id: string;
}

export interface MessageParams {
	session_id: string;
	/**
	 * The id this client minted for the message (`generateUUID`): its record
	 * carries it, which is how this client knows its own message when the
	 * record arrives, and the server sends nothing under an id its history
	 * already holds, so a retry cannot send it twice.
	 */
	message_id: string;
	content: string;
	/**
	 * The posted questions this message answers. The server validates every
	 * entry against the session's live list before delivering anything and
	 * refuses the whole message with `-32602` naming the ones that are no longer
	 * pending — the body is one string, so there is no half of it to deliver.
	 */
	answering?: QuestionAnswerParams[];
	/**
	 * Files sent with the message, by the ids `POST /api/chat/attachments`
	 * returned for this session. `content` may be empty when there are any.
	 * Refused beside `answering`, and refused whole (`-32602`) when an id names
	 * nothing the session has or the session's agent cannot receive files.
	 */
	attachments?: MessageAttachmentParams[];
}

/** One uploaded file a message carries; `name` is what the user calls it. */
export interface MessageAttachmentParams {
	id: string;
	name?: string;
}

/**
 * What a page sent the agent (docs/tool-call-ui.md § The action message): a
 * `message` record's `html_action`. An event — what was pressed on which
 * page — never state.
 */
export type HtmlAction = Wire.Action;

export interface HtmlActionParams {
	session_id: string;
	/** As `MessageParams.message_id`: the action is sent as a message. */
	message_id: string;
	page: string;
	/** 1–128 characters, no control characters. */
	action: string;
	/** Any JSON; omitted = `{}`; at most 64KB serialized. */
	data?: unknown;
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
	choice: Wire.PermissionChoiceName;
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
	mode: ReportedSessionMode;
	agent_type: AgentType;
	/** Empty means "pass no model flag, let the CLI pick". */
	model: string;
	/** Empty means "pass no effort flag, let the CLI keep its default". */
	effort: string;
	/** True once the agent has produced output in this session. */
	activated: boolean;
	/**
	 * True from just before the first message is delivered, and never cleared;
	 * a fork is started from birth. It is what fixes `html_first`, and it is not
	 * `activated`, which waits for the agent's first output.
	 */
	started: boolean;
	/**
	 * The agent starts told to say things with pages. A draft until `started`,
	 * fixed after (docs/html-first-session-ui.md §1). Absent means an ordinary
	 * chat.
	 */
	html_first?: boolean;
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
	/** `SessionListItem.watching`, here for the reason `work_id` is. */
	watching?: number;
	/**
	 * `SessionListItem.permission_reviewer_of`, here for the reason `work_id` is:
	 * the filter hides reviewers too. It is what makes the screen read-only
	 * (docs/unattended-mode-ui.md §5).
	 */
	permission_reviewer_of?: string;
	/**
	 * The stories `watching` counts, for the open session: the chat that says it
	 * is watching is the surface that lists what. A row is sent the count alone.
	 * Absent means none.
	 */
	watched_stories?: WatchedStory[];
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
	/**
	 * A permission request the session's permission reviewer is answering, set
	 * from the moment it is raised; absent means false. A person can still
	 * answer it, but nobody is waiting on them (docs/unattended-mode.md).
	 */
	reviewing?: boolean;
}

/** `blocked` is exactly "there is at least one blocker": the server derives the
 * phase rather than letting it drift from them, so nothing here has to look past
 * `phase` to find out. */
export type TurnPhase = "idle" | "running" | "blocked";

export type TurnOutcome = "completed" | "failed" | "auth_failed" | "aborted";

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
	/**
	 * How long the open turn has run, as of the moment the server sent this;
	 * absent while `open` is false. A reading rather than a timestamp, so the
	 * tail line counts on from when it arrived and never compares the server's
	 * clock with this device's (docs/turn-progress-ui.md §2.3). Unlike `since` it
	 * does not reset when the turn blocks and resumes.
	 */
	open_elapsed_ms?: number;
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
	/** Asks to continue the copy this client holds; omitted asks for a page. */
	resume?: ChatResume;
}

/**
 * The copy of a transcript a re-subscribing client holds (`rpc.ChatResume`):
 * how a reconnect keeps the pages the user had scrolled back through.
 */
export interface ChatResume {
	/**
	 * `AuthResult.server_instance` of the connection the copy was read over.
	 * The server answers one that is not its own with a snapshot: its seqs
	 * may name other records now.
	 */
	server_instance: string;
	/**
	 * The `through_seq` of the last page or update the copy applied: it holds
	 * everything up to it.
	 */
	after_seq: HistorySeq;
}

/**
 * One page of the transcript: its items grouped into turns, oldest first
 * (docs/agent-chat.md#history-paging). `next_before_seq` is the cursor for the
 * page before this one, absent once `has_more` is false.
 */
export type ChatMessagesHistoryPage = ChatPage;

interface ChatSubscribeStart {
	/**
	 * What the session is doing at the moment of subscribing. Read for the
	 * session's turn until `session.detail` reports it; the transcript itself
	 * is the items'.
	 */
	turn: SessionTurn;
	/**
	 * What is still being generated as of the subscription: the main agent's
	 * thinking, and what each call in flight has said about itself. Never
	 * recorded, so a client subscribing mid-run learns it only here; the
	 * subscription's `chat.delta` notifications continue it. Replaces what
	 * the client held of it on a resume too.
	 */
	streams?: ChatStreams;
	/** The server's clock as it built the reply (RFC 3339). */
	server_time?: string;
}

/**
 * Which of its two starts a subscription was given (`rpc.ChatDelivery`). A
 * snapshot is the newest page, and replaces whatever the client held, older
 * pages included. A resume is an update to the copy named in `resume`, which
 * the client keeps: what the records after `after_seq` changed, applied as a
 * `chat.update` is. A client that asked to resume may be given a snapshot —
 * another server instance, or a gap the server will not answer as an update
 * — and is never refused for asking.
 */
export type ChatMessagesSubscribeResult =
	| (ChatPage & ChatSubscribeStart & { delivery: "snapshot" })
	| (ChatSubscribeStart & {
			delivery: "resume";
			update: Omit<ChatUpdate, "type" | "streams_ended">;
	  });

export interface ChatMessagesHistoryParams {
	session_id: string;
	/** Exclusive: the reply holds the records immediately older than this one. */
	before_seq?: HistorySeq;
	limit?: number;
}

export type ChatMessagesHistoryResult = ChatPage;

export interface SessionSetHTMLFirstParams {
	session_id: string;
	html_first: boolean;
}

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

/** Everything a chat subscription's callback can receive. */
export type { ChatNotification } from "./chatItems";
