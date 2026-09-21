import type { ContentBlock } from "../types/content";
import type {
	AskUserQuestion,
	AssistantMessage,
	ContentPart,
	ExpiryReason,
	HistorySeq,
	Message,
	MessageOrigin,
	PermissionUpdate,
	QuestionAnswerRecord,
	QuestionRecordStatus,
	ServerNotification,
	SessionTurn,
	SystemMessageMeta,
	ToolFetch,
	ToolRun,
	UserMessage,
} from "../types/message";
import { lookupAnswer, parseAnswer } from "../utils/questionAnswer";
import { generateUUID } from "../utils/uuid";
import { parseContentBlocks } from "./contentBlocks";

// Legacy history recorded system messages with origin "work" before the
// concept was renamed to "system". Map the old value so old sessions still
// take the system path.
function normalizeOrigin(raw: unknown): MessageOrigin | undefined {
	if (raw === "system" || raw === "work") return "system";
	if (raw === "user") return "user";
	if (raw === "agent") return "agent";
	return undefined;
}

// The four reasons a card can stop waiting for an answer, checked at the wire
// boundary like every other closed set: a value this build does not know reads
// as no reason at all, which is a banner that is true of all of them — never a
// card that renders nothing. Which reasons can reach which card is `ExpiryReason`.
const EXPIRY_REASONS: readonly string[] = [
	"process_ended",
	"timeout",
	"work_closed",
	"step_done",
];

function normalizeExpiryReason(raw: unknown): ExpiryReason | undefined {
	return typeof raw === "string" && EXPIRY_REASONS.includes(raw)
		? (raw as ExpiryReason)
		: undefined;
}

// Boundary defense for one question's shape: the Go encoder emits `null` for a
// nil `options` slice, and a record may carry none at all.
function normalizeQuestion(raw: AskUserQuestion | undefined): AskUserQuestion {
	return {
		question: raw?.question ?? "",
		header: raw?.header ?? "",
		options: raw?.options ?? [],
		multiSelect: raw?.multiSelect ?? false,
	};
}

// The `answering` entries of a message record. Absent and empty mean the same
// thing — an ordinary message — and both read as undefined so nothing
// downstream has to tell them apart.
function normalizeAnswering(raw: unknown): QuestionAnswerRecord[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	return raw as QuestionAnswerRecord[];
}

// A cancelled question is stored with a nil answers map, and `omitempty` on the
// Go side then drops the key from the record entirely — so cancellation reaches
// the client as an absent field, not as null. Both mean cancelled.
function normalizeAnswers(raw: unknown): Record<string, string> | null {
	if (raw === null || typeof raw !== "object") return null;
	return raw as Record<string, string>;
}

// Normalized event with camelCase (internal representation)
export type NormalizedEvent =
	| { type: "text"; content: string }
	| {
			type: "tool_call";
			toolUseId: string;
			toolName: string;
			toolInput: unknown;
			/**
			 * The earlier call this one reads the output of, resolved by the
			 * adapter because only it can turn a `task_id` into a `tool_use_id`.
			 * Absent is ordinary, not an error: a task that has already settled,
			 * or one a previous process started, can no longer be named.
			 */
			originToolUseId?: string;
	  }
	| {
			type: "tool_result";
			toolUseId: string;
			toolResult: string;
			/**
			 * The result cut into blocks, set only when it was not prose alone.
			 * When present it holds the whole result, text included, and
			 * `toolResult` is empty.
			 */
			contents?: ContentBlock[];
			isError: boolean;
			/**
			 * `background_started` for the placeholder a backgrounded call handed
			 * back, `background_result` for the outcome that arrived after the
			 * turn, `background_lost` for the one Pockode wrote itself when the
			 * process died with the work still running. Empty for every ordinary
			 * result.
			 */
			subtype?: string;
			durationMs?: number;
			exitCode?: number;
	  }
	| {
			/**
			 * What a call that has not returned is doing. Never persisted, so it
			 * only ever reaches a client that was listening at the time — plus the
			 * snapshot a mid-run subscription is handed.
			 */
			type: "tool_activity";
			toolUseId: string;
			/** A latest value: empty leaves the last one standing. */
			activity?: string;
			/** An increment: it accumulates into the run's output. */
			outputDelta?: string;
	  }
	| { type: "warning"; message: string; code: string }
	| { type: "error"; error: string }
	| { type: "done" }
	| { type: "interrupted" }
	| { type: "process_ended" }
	/** The turn parked on background work; neither an ending nor output. */
	| { type: "background_wait" }
	| { type: "system"; content: string }
	| {
			// User message or system-driven message (history replay or broadcast)
			type: "message";
			content: string;
			origin?: MessageOrigin;
			subtype?: string;
			meta?: SystemMessageMeta;
			/** The posted questions this message answers; see QuestionAnswerRecord. */
			answering?: QuestionAnswerRecord[];
	  }
	| {
			type: "permission_request";
			requestId: string;
			toolName: string;
			toolInput: unknown;
			toolUseId: string;
			permissionSuggestions?: PermissionUpdate[];
	  }
	| {
			type: "permission_response";
			requestId: string;
			choice: "deny" | "allow" | "always_allow";
	  }
	| {
			type: "request_cancelled";
			requestId: string;
			reason?: ExpiryReason;
			resolvedAt?: string;
	  }
	| {
			/**
			 * A question the CLI asked through its own blocking tool. Read from old
			 * transcripts and never produced: Pockode refuses that tool now
			 * (`agent.CLIQuestionRefusal`). It could carry several questions at once.
			 */
			type: "legacy_question";
			requestId: string;
			toolUseId: string;
			questions: AskUserQuestion[];
	  }
	| {
			/** One question the agent posted through `question_post`. */
			type: "question_posted";
			requestId: string;
			question: AskUserQuestion;
			askedAt?: string;
	  }
	| {
			/** The answer to a `legacy_question`, from the same old transcripts. */
			type: "question_response";
			requestId: string;
			answers: Record<string, string> | null;
	  }
	| { type: "raw"; content: string }
	| { type: "command_output"; content: string };

/**
 * The record's address in the session's history, as handed out by the server —
 * with replayed history, with every live notification, and in the reply telling
 * a client where its own message landed, so a client cannot tell any of them
 * apart when it later names a record.
 *
 * Absent for an event that was never persisted, for a record the store
 * synthesized rather than read from the file (the damaged-history warning, which
 * carries seq 0 so that it cannot be confused with a real record), and from a
 * server too old to put one there. Absent means "not addressable", never
 * "position zero".
 *
 * Not absent for history written before seqs existed: replay stamps every
 * unaddressed record by position (session.stampHistorySeq).
 */
export function readHistorySeq(e: unknown): HistorySeq | undefined {
	const seq = (e as Record<string, unknown> | undefined)?.seq;
	return typeof seq === "number" && seq > 0 ? seq : undefined;
}

// Convert snake_case server event to camelCase
export function normalizeEvent(
	e: ServerNotification | Record<string, unknown>,
): NormalizedEvent {
	const record = e as Record<string, unknown>;
	const type = record.type as string;

	switch (type) {
		case "text":
			return { type: "text", content: (record.content as string) ?? "" };
		case "tool_call":
			return {
				type: "tool_call",
				toolUseId: record.tool_use_id as string,
				toolName: record.tool_name as string,
				toolInput: record.tool_input,
				originToolUseId: record.origin_tool_use_id as string | undefined,
			};
		case "tool_result":
			return {
				type: "tool_result",
				toolUseId: record.tool_use_id as string,
				toolResult: (record.tool_result as string) ?? "",
				contents: parseContentBlocks(record.contents),
				isError: record.is_error === true,
				subtype: record.subtype as string | undefined,
				// Zero is what an engine that reports no duration sends, and it
				// means the same as absent: nobody measured this call.
				durationMs:
					typeof record.duration_ms === "number" && record.duration_ms > 0
						? record.duration_ms
						: undefined,
				exitCode:
					typeof record.exit_code === "number" ? record.exit_code : undefined,
			};
		case "tool_activity":
			return {
				type: "tool_activity",
				toolUseId: record.tool_use_id as string,
				activity: record.activity as string | undefined,
				outputDelta: record.output_delta as string | undefined,
			};
		case "warning":
			return {
				type: "warning",
				message: (record.message as string) ?? "",
				code: (record.code as string) ?? "",
			};
		case "error":
			return { type: "error", error: (record.error as string) ?? "" };
		case "done":
			return { type: "done" };
		case "interrupted":
			return { type: "interrupted" };
		case "process_ended":
			return { type: "process_ended" };
		case "background_wait":
			return { type: "background_wait" };
		case "system":
			return { type: "system", content: (record.content as string) ?? "" };
		case "message":
			return {
				type: "message",
				content: (record.content as string) ?? "",
				origin: normalizeOrigin(record.origin),
				subtype: record.subtype as string | undefined,
				meta: record.meta as SystemMessageMeta | undefined,
				answering: normalizeAnswering(record.answering),
			};
		case "permission_request":
			return {
				type: "permission_request",
				requestId: record.request_id as string,
				toolName: record.tool_name as string,
				toolInput: record.tool_input,
				toolUseId: record.tool_use_id as string,
				permissionSuggestions: record.permission_suggestions as
					| PermissionUpdate[]
					| undefined,
			};
		case "permission_response":
			return {
				type: "permission_response",
				requestId: record.request_id as string,
				choice: record.choice as "deny" | "allow" | "always_allow",
			};
		case "request_cancelled":
			return {
				type: "request_cancelled",
				requestId: record.request_id as string,
				reason: normalizeExpiryReason(record.reason),
				resolvedAt: record.resolved_at as string | undefined,
			};
		case "question_posted":
			return {
				type: "question_posted",
				requestId: record.request_id as string,
				// The server writes exactly one, in a one-element list so that this
				// and the CLI's own prompt share a renderer. A record with none
				// names nothing answerable; the empty question keeps the card
				// drawable rather than crashing the transcript over it.
				question: normalizeQuestion(
					(record.questions as AskUserQuestion[] | undefined)?.[0],
				),
				askedAt: record.asked_at as string | undefined,
			};
		case "ask_user_question":
			return {
				type: "legacy_question",
				requestId: record.request_id as string,
				toolUseId: record.tool_use_id as string,
				// Boundary defense for shape drift across the WS contract: the
				// Go encoder omits empty `questions` and emits `null` for a nil
				// `options` slice. Coerce to the non-nullable TS shape here so
				// downstream code can trust the types.
				questions: (
					(record.questions as AskUserQuestion[] | undefined) ?? []
				).map((q) => ({ ...q, options: q.options ?? [] })),
			};
		case "question_response":
			return {
				type: "question_response",
				requestId: record.request_id as string,
				answers: normalizeAnswers(record.answers),
			};
		case "raw":
			return { type: "raw", content: (record.content as string) ?? "" };
		case "command_output":
			return {
				type: "command_output",
				content: (record.content as string) ?? "",
			};
		default:
			// Fallback for unknown types - treat as raw
			return { type: "raw", content: JSON.stringify(record) };
	}
}

/**
 * Options that describe how an event reached this client, rather than what it
 * says. Only liveness so far: a record replayed from history is
 * indistinguishable from a live one in its own right, and a run may only draw a
 * stopwatch if this client watched it start.
 */
export interface ApplyOptions {
	/** True for an event that arrived on the wire while the client was watching. */
	live?: boolean;
}

/**
 * Where this call already sits in the list, or -1.
 *
 * One part per `tool_use_id`, which is what keeps a call announced twice from
 * drawing two rows. Claude 2.1.263 does not re-send a `tool_call` after
 * approval (measured), but an older CLI did and a future one may again, and a
 * second announcement describes the call already here.
 */
function findToolRunIndex(parts: ContentPart[], toolUseId: string): number {
	return parts.findIndex(
		(part) => part.type === "tool_call" && part.tool.id === toolUseId,
	);
}

/**
 * The `question_post` tool row a `question_posted` record belongs to, or -1.
 *
 * Joined by position rather than by `tool_use_id`, because there is none to
 * join on: a `question_post` call reaches the server over HTTP from the MCP
 * endpoint, and the CLI's id for the tool use is not in that request. What the
 * server does guarantee is when the record is written — during the call — so
 * the record always falls between that call's `tool_call` and its
 * `tool_result`. The last unreturned call whose name ends in `question_post` is
 * therefore this question's, and a join that misses simply leaves two rows
 * rather than getting one wrong (docs/tool-call-ui.md).
 */
function openQuestionPostIndex(parts: ContentPart[]): number {
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		if (part.type !== "tool_call") continue;
		if (part.tool.status !== "running") continue;
		if (part.tool.name.endsWith("question_post")) return i;
	}
	return -1;
}

function applyToolCall(
	parts: ContentPart[],
	toolUseId: string,
	toolName: string,
	toolInput: unknown,
	options: ApplyOptions,
): ContentPart[] {
	const index = findToolRunIndex(parts, toolUseId);
	if (index !== -1) {
		const part = parts[index];
		if (part.type !== "tool_call") return parts; // Type guard - never happens
		// A resend refreshes what the call says it will do and leaves the run's
		// own state alone: by now it may already have finished.
		const updated = [...parts];
		updated[index] = {
			...part,
			tool: { ...part.tool, name: toolName, input: toolInput },
		};
		return updated;
	}

	// A card the user has not answered *is* this call's row: nothing about the
	// call is running while it waits for them, and a second row — above the card
	// on Claude, below it on Codex, which may ask before it announces the item —
	// would say the machine is busy. The row comes back when the engine reports
	// (see `updateRunById`), rebuilt from what the card carries, which is the
	// same input this call announced.
	if (
		parts.some(
			(part) =>
				part.type === "permission_request" &&
				part.request.toolUseId === toolUseId &&
				part.status === "pending",
		)
	) {
		return parts;
	}

	// No row for this call yet — either it is new, or a card that has since been
	// answered took the pending row's place and this resend is the call starting.
	return [
		...parts,
		{
			type: "tool_call",
			tool: {
				id: toolUseId,
				name: toolName,
				input: toolInput,
				status: "running",
				...(options.live ? { seenAt: new Date() } : {}),
			},
		},
	];
}

export function applyEventToParts(
	parts: ContentPart[],
	event: NormalizedEvent,
	options: ApplyOptions = {},
): ContentPart[] {
	switch (event.type) {
		case "text": {
			const lastPart = parts[parts.length - 1];
			if (lastPart?.type === "text") {
				return [
					...parts.slice(0, -1),
					{ type: "text", content: lastPart.content + event.content },
				];
			}
			return [...parts, { type: "text", content: event.content }];
		}
		case "tool_call":
			return applyToolCall(
				parts,
				event.toolUseId,
				event.toolName,
				event.toolInput,
				options,
			);
		case "permission_request": {
			const permissionPart: ContentPart = {
				type: "permission_request",
				request: {
					requestId: event.requestId,
					toolName: event.toolName,
					toolInput: event.toolInput,
					toolUseId: event.toolUseId,
					permissionSuggestions: event.permissionSuggestions,
				},
				status: "pending",
			};
			// The card takes the call's place rather than sitting beside it: while
			// the user is deciding, the machine is waiting for *them*, and a row
			// spinning above the card would say the opposite. Same join
			// `ask_user_question` makes below — all of it describes one tool use.
			const index = event.toolUseId
				? findToolRunIndex(parts, event.toolUseId)
				: -1;
			if (index === -1) return [...parts, permissionPart];

			const updated = [...parts];
			updated[index] = permissionPart;
			return updated;
		}
		case "legacy_question": {
			// One card per question rather than one card carrying several. The new
			// records are one question each, so this is what makes an old transcript
			// render through the same component as a new one — and the shared
			// `request_id` is right, not a collision: an answer to that request
			// settled every question in it at once.
			const cards: ContentPart[] = event.questions.map((question) => ({
				type: "question_record",
				record: { requestId: event.requestId, question },
				status: "pending",
				legacy: true,
			}));
			// The CLI emitted tool_call for its ask tool immediately before the
			// question and a tool_result echoing the answers after. All of it
			// describes one tool use and the cards already render the interaction,
			// so they take the tool_call's place rather than sit beside a row
			// duplicating it. The trailing tool_result then matches no tool_call and
			// is dropped as an orphan.
			const toolCallIndex = event.toolUseId
				? findToolRunIndex(parts, event.toolUseId)
				: -1;
			if (toolCallIndex === -1) return [...parts, ...cards];

			const updated = [...parts];
			updated.splice(toolCallIndex, 1, ...cards);
			return updated;
		}
		case "question_posted": {
			const questionPart: ContentPart = {
				type: "question_record",
				record: {
					requestId: event.requestId,
					question: event.question,
					askedAt: event.askedAt,
				},
				status: "pending",
			};
			// The card takes the tool row's place, the same generalisation
			// `permission_request` and `ask_user_question` make above: both rows
			// describe one act, and drawing them side by side is the duplication
			// tool-call-ui.md removed once already.
			const index = openQuestionPostIndex(parts);
			if (index === -1) return [...parts, questionPart];

			const updated = [...parts];
			updated[index] = questionPart;
			return updated;
		}
		case "system":
			return [...parts, { type: "system", content: event.content }];
		case "warning":
			return [
				...parts,
				{ type: "warning", message: event.message, code: event.code },
			];
		case "raw":
			return [...parts, { type: "raw", content: event.content }];
		case "command_output":
			return [...parts, { type: "command_output", content: event.content }];
		default:
			return parts;
	}
}

export function createAssistantMessage(
	status: AssistantMessage["status"] = "streaming",
): AssistantMessage {
	return {
		id: generateUUID(),
		role: "assistant",
		parts: [],
		status,
		createdAt: new Date(),
	};
}

/** Index of the last assistant bubble, whatever state it is in. -1 for none. */
function lastAssistantIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return i;
	}
	return -1;
}

/**
 * Index of the bubble the open turn is writing into — the last assistant still
 * `sending` or `streaming` — or -1 when no turn is writing.
 *
 * Deliberately not "the last message, if it is an open assistant", and not even
 * "the last assistant, if it is open": a message sent while the agent is
 * mid-reply is appended below that reply, and a send that then fails leaves its
 * reason below that. Either would hide the running turn behind them, and the
 * `done` meant for it would be dropped as belonging to no one — leaving a
 * spinner nothing could stop.
 *
 * At most one bubble is ever open, so scanning past closed ones cannot pick the
 * wrong turn: a turn only opens a bubble when this returns -1.
 */
export function openAssistantIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		if (m.status === "sending" || m.status === "streaming") return i;
	}
	return -1;
}

/**
 * Writes a record's seq onto the message it was folded into, so a fork can name
 * that message as its cut point (docs/session-fork-ui.md).
 *
 * Only ever the last message: an event that lands in an earlier one — a
 * tool_result arriving after its turn was interrupted — must not push that
 * message's anchor past the messages below it, or the fork would cut somewhere
 * later than the bubble the user pointed at. The record stays unaddressable
 * instead, which the client is free to do: it only ever anchors on records it
 * has been given a seq for.
 */
function stampAnchorSeq(
	before: Message[],
	after: Message[],
	seq: HistorySeq | undefined,
): Message[] {
	if (seq === undefined || after.length === 0) return after;

	const index = after.length - 1;
	const last = after[index];
	// Compared against the same position rather than the end of `before`: a
	// terminal event can drop an empty placeholder, and the message left behind
	// is then an old one that this record did not touch.
	if (last === before[index]) return after;

	const updated = [...after];
	updated[index] = { ...last, anchorSeq: seq };
	return updated;
}

/**
 * Gives one already-rendered message its address in history.
 *
 * For the message this client sent itself: it is echoed locally before the
 * server has recorded it, and the broadcast that would carry its seq is the one
 * the sender is excluded from, so the number arrives separately — in the reply to
 * `chat.message` — after the bubble is on screen. Stamped by id rather than by
 * position because the message is rarely the last element by the time the seq
 * lands: opening a turn leaves an empty assistant placeholder behind it, sending
 * into a running turn leaves the reply above still growing, and either way the
 * agent may have streamed several messages in while the call was in flight.
 *
 * Returns the list untouched when there is nothing to stamp — no seq, or the
 * message is gone because the user switched sessions, whose history this seq
 * names nothing in.
 */
export function stampMessageAnchorSeq(
	messages: Message[],
	messageId: string,
	seq: HistorySeq | undefined,
): Message[] {
	if (seq === undefined) return messages;

	const index = messages.findIndex((m) => m.id === messageId);
	if (index === -1) return messages;

	const updated = [...messages];
	updated[index] = { ...messages[index], anchorSeq: seq };
	return updated;
}

// Shared by history replay and real-time streaming. `seq` is the record's
// address in history, absent for an event that was never persisted.
export function applyServerEvent(
	messages: Message[],
	event: NormalizedEvent,
	seq?: HistorySeq,
	options: ApplyOptions = {},
): Message[] {
	// User message or system-driven message (history replay or broadcast)
	if (event.type === "message") {
		// The cards first: the questions this message answers may be anywhere in
		// the transcript, and settling them before the bubble is appended keeps
		// the pass over `messages` off the message just added, which answers
		// nothing of its own.
		const settled = event.answering
			? applyAnswering(messages, event.answering)
			: messages;
		// Stamped inside applyUserMessage rather than by stampAnchorSeq: when the
		// message opens a turn it is followed by an empty assistant placeholder, so
		// the last element is not the one holding the record.
		return applyUserMessage(settled, event.content, {
			source: event.origin,
			subtype: event.subtype,
			meta: event.meta,
			anchorSeq: seq,
			answering: event.answering,
		});
	}

	return stampAnchorSeq(messages, applyEvent(messages, event, options), seq);
}

function applyEvent(
	messages: Message[],
	event: NormalizedEvent,
	options: ApplyOptions,
): Message[] {
	// Permission response updates existing permission_request across all messages
	if (event.type === "permission_response") {
		const newStatus = event.choice === "deny" ? "denied" : "allowed";
		return updatePermissionRequestStatus(messages, event.requestId, newStatus);
	}

	// Request cancelled (the CLI withdrew it, or Pockode recorded what became of
	// a prompt nobody answered)
	if (event.type === "request_cancelled") {
		return applyCancellation(messages, event.requestId, event.reason);
	}

	// Replay only: the answer to a question the CLI's own tool asked, which
	// nothing produces any more. It settles the legacy cards that share its
	// request id.
	if (event.type === "question_response") {
		return settleLegacyQuestion(messages, event.requestId, event.answers);
	}

	// The turn parking on background work says nothing about the transcript: the
	// server records it so the session's turn state can say the agent is waiting
	// rather than thinking (agent-integration.md#background-waits), and drawing it
	// is not wired up yet. Ignored outright rather than falling through, which
	// would open an empty assistant bubble for it.
	if (event.type === "background_wait") {
		return messages;
	}

	// A call that only reads an earlier call's task belongs *on* that call, not
	// beside it: its own row would sit a screenful below the work it describes
	// with nothing but an opaque id to tie the two together. So it never reaches
	// the transcript at all — unless the row it names is not loaded, and then it
	// falls through to become an ordinary row, which is a common case rather
	// than a fallback (docs/code/frontend-state.md).
	if (event.type === "tool_call" && event.originToolUseId) {
		const absorbed = absorbFetchCall(
			messages,
			event.originToolUseId,
			event.toolUseId,
		);
		if (absorbed) return absorbed;
	}

	// Tool result updates existing tool_call across all messages (may arrive after interrupt)
	if (event.type === "tool_result") {
		return updateToolResult(messages, event);
	}

	// As does a progress line, which belongs to a call that may be several turns
	// above — a backgrounded one reports while the conversation carries on.
	if (event.type === "tool_activity") {
		return updateToolActivity(messages, event);
	}

	// Terminal events only make sense for active (sending/streaming) messages
	const isTerminalEvent =
		event.type === "interrupted" ||
		event.type === "process_ended" ||
		event.type === "done" ||
		event.type === "error";

	// The turn's own bubble, wherever it sits. It is not always the last message:
	// a message sent mid-turn lands *below* the reply still being written, and
	// that reply belongs to the turn that was already running, not to what the
	// user just typed. So a turn's bubble is opened by its first content event
	// and closed by its terminal event — never by a user message coming in
	// underneath it (docs/lifecycle-ui.md §2.3).
	//
	// This is the one thing keeping two turns' output apart: without `done` /
	// `interrupted` / `error` arriving, the next turn would grow into this
	// bubble. `messageReducer.test.ts` states that dependency as a test, because
	// it used to be covered by a second, accidental rule — a user message closed
	// the previous turn — that mid-turn sending had to remove.
	const openIndex = openAssistantIndex(messages);
	const hasActiveAssistant = openIndex >= 0;

	// Output the CLI was already producing when the turn was cut short still
	// arrives afterwards — a Task subagent's last words are the common case.
	// Once a turn has ended, the next one starts from a `message` event, which
	// leaves its own placeholder to stream into (the agent also resumes on a
	// permission or question answer, but a turn cut short takes its pending
	// dialogs down with it, so there is nothing left to answer). Content with
	// no such message before it therefore belongs to the turn that just ended:
	// it is appended there, and the ended status stands.
	//
	// `complete` is deliberately not an ended turn here: when a background wait
	// runs out of budget Pockode delivers the end of turn itself, and the CLI
	// may genuinely resume output afterwards — that output is a live turn and
	// must still light up the spinner.
	//
	// Read off the last assistant rather than the last message for the same
	// reason as above: a message sent mid-turn sits below the bubble the trailing
	// output belongs to.
	const endedIndex = lastAssistantIndex(messages);
	const ended = endedIndex >= 0 ? messages[endedIndex] : undefined;
	const turnEnded =
		ended?.role === "assistant" &&
		(ended.status === "interrupted" ||
			ended.status === "error" ||
			ended.status === "process_ended");
	const isLateContent = !hasActiveAssistant && turnEnded && !isTerminalEvent;

	let updated: Message[];
	let index: number;
	if (hasActiveAssistant || isLateContent) {
		updated = [...messages];
		index = hasActiveAssistant ? openIndex : endedIndex;
	} else {
		if (isTerminalEvent) {
			// No active message to terminate — but still expire pending dialogs on process end
			if (event.type === "process_ended") {
				return settleAfterProcessGone(messages);
			}
			return messages;
		}
		// Content with no turn to belong to opens one. This is the path a message
		// sent mid-turn takes when the turn it went into ends and the agent then
		// answers it, and the path the first content of any turn takes.
		//
		// Nothing is swept up first: reaching here means `openAssistantIndex` found
		// no bubble open anywhere, so there is no earlier turn left running to
		// close out.
		updated = [...messages, createAssistantMessage()];
		index = updated.length - 1;
	}

	const current = updated[index];
	if (current.role !== "assistant") {
		return updated; // Type guard - should never happen
	}

	const message: AssistantMessage = {
		...current,
		parts: applyEventToParts(current.parts, event, options),
	};

	// An ended turn keeps the status it ended with: output trailing it cannot
	// reopen it.
	if (!isLateContent) {
		if (event.type === "text") {
			message.status = "streaming";
		} else if (event.type === "done") {
			message.status = "complete";
		} else if (event.type === "interrupted") {
			message.status = "interrupted";
		} else if (event.type === "error") {
			message.status = "error";
			message.error = event.error;
		} else if (event.type === "process_ended") {
			message.status = "process_ended";
		}
	}

	// A turn that ended this way has no call left running: not the one it was
	// cut off in the middle of, and not one whose call trails in afterwards
	// either. Keyed on the resulting status rather than on the event so that
	// late content lands under the same rule.
	//
	// `complete` is deliberately absent: background work outlives the turn that
	// started it and reports back later
	// (agent-integration.md#background-waits).
	if (
		message.status === "interrupted" ||
		message.status === "error" ||
		message.status === "process_ended"
	) {
		message.parts = settleRunningToolParts(message.parts);
	}

	updated[index] = message;

	if (event.type === "process_ended") {
		updated = settleAfterProcessGone(updated);
	}

	// A terminal event settles every bubble's fate, so this is where an empty one
	// stops being a placeholder and becomes a blank box.
	if (isTerminalEvent) {
		updated = updated.filter((m) => {
			if (m.role !== "assistant" || m.parts.length > 0) return true;
			// Orphan sends and turns that ended having produced nothing: no content,
			// and after this event none is coming.
			return m.status !== "sending" && !isEmptyPlaceholder(m);
		});
	}

	return updated;
}

/**
 * Retires the permission requests nothing can decide any more.
 *
 * `stillLive` names the requests the session still lists as blockers, and a card
 * not in it has lost the process that would take its decision. Omitting it
 * retires every pending one, which is what a `process_ended` record means.
 *
 * **Permission cards only, and that is the point of the design this replaced.** A
 * question card belongs to the session rather than to the process that asked, so
 * a process ending is not an ending for it — nothing here may touch one, and the
 * only things that settle one are records naming it (see `applyCancellation`,
 * `settleLegacyQuestion`). A legacy card nothing settled stays `pending` and says
 * in its own body that it can no longer be answered, which is a truer statement
 * than `expired` ever was and does not need this function to make it.
 */
export function expirePendingDialogs(
	messages: Message[],
	stillLive?: ReadonlySet<string>,
	reason?: ExpiryReason,
): Message[] {
	const isLive = (requestId: string) => stillLive?.has(requestId) ?? false;
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;

		let changed = false;
		const updatedParts = msg.parts.map((part) => {
			if (
				part.type === "permission_request" &&
				part.status === "pending" &&
				!isLive(part.request.requestId)
			) {
				changed = true;
				return { ...part, status: "expired" as const, reason };
			}
			return part;
		});

		if (!changed) return msg;
		anyChanged = true;
		return { ...msg, parts: updatedParts };
	});
	return anyChanged ? updated : messages;
}

/**
 * Retires the prompt this cancellation names, and records why.
 *
 * Both card kinds in one pass: a request id belongs to exactly one of them, and
 * a withdrawal is the one thing that can settle either.
 *
 * **A card that is already expired still takes the reason**, and that is the
 * case this is written for rather than an afterthought. The same expiry reaches
 * the client twice over two channels — the session's turn stops listing the
 * blocker (`retireAgainstTurn`, which knows *that* it ended but not *why*), and
 * this record says why — and they can arrive in either order. Guarding on
 * `pending` alone would leave whichever card lost that race stuck on the
 * reason-neutral banner.
 *
 * A reason already on the card wins: the first record to name one is the one
 * that settled it, and nothing that follows can know better.
 */
function applyCancellation(
	messages: Message[],
	requestId: string,
	reason?: ExpiryReason,
): Message[] {
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;

		let changed = false;
		const updatedParts = msg.parts.map((part) => {
			// A posted question is withdrawn, never expired: it belongs to the
			// session rather than to the process that asked it, so the only thing
			// that retires it is something naming it (docs/answering-ui.md §6). A
			// legacy card is settled the same way — its CLI withdrawing the
			// question is the one thing that can still name it.
			if (part.type === "question_record") {
				if (part.record.requestId !== requestId) return part;
				if (part.status !== "pending") return part;
				changed = true;
				return { ...part, status: "cancelled" as const, reason };
			}
			if (part.type !== "permission_request") return part;
			if (part.request.requestId !== requestId) return part;

			if (part.status === "pending") {
				changed = true;
				return { ...part, status: "expired" as const, reason };
			}
			if (part.status === "expired" && reason && part.reason === undefined) {
				changed = true;
				return { ...part, reason };
			}
			return part;
		});

		if (!changed) return msg;
		anyChanged = true;
		return { ...msg, parts: updatedParts };
	});
	return anyChanged ? updated : messages;
}

/**
 * Puts a permission card back to undecided, whatever it currently says.
 *
 * The one caller is a decision the server refused: this client had already
 * written the optimistic outcome, and the refusal means it never happened.
 * Unlike every other transition here this one does not guard on `pending`,
 * because the status it is correcting is one this client wrote a moment ago and
 * no longer believes.
 *
 * A permission card is the only kind that needs this. A refused *answer* takes
 * its whole optimistic echo with it — the message bubble and all — because the
 * server wrote nothing and delivered nothing (`useChatMessages.sendUserMessage`),
 * so there is no half-applied outcome left to undo.
 *
 * **Which** unanswered status is the caller's to decide, and it is not a detail:
 * a refusal because the process is gone leaves a card nothing can ever answer,
 * while a refusal because the socket dropped leaves one that is still waiting.
 * Guessing `expired` for both would retire a live prompt on a blip.
 */
export function resetPromptRequest(
	messages: Message[],
	requestId: string,
	status: "pending" | "expired",
): Message[] {
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;

		let changed = false;
		const updatedParts = msg.parts.map((part) => {
			const isTarget =
				part.type === "permission_request" &&
				part.request.requestId === requestId;
			if (!isTarget || part.status === status) return part;
			changed = true;
			return { ...part, status };
		});

		if (!changed) return msg;
		anyChanged = true;
		return { ...msg, parts: updatedParts };
	});
	return anyChanged ? updated : messages;
}

export function updatePermissionRequestStatus(
	messages: Message[],
	requestId: string,
	newStatus: "allowed" | "denied",
): Message[] {
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;

		let changed = false;
		const updatedParts = msg.parts.map((part) => {
			if (
				part.type === "permission_request" &&
				part.request.requestId === requestId &&
				part.status === "pending"
			) {
				changed = true;
				return { ...part, status: newStatus };
			}
			return part;
		});

		if (!changed) return msg;
		anyChanged = true;
		return { ...msg, parts: updatedParts };
	});
	return anyChanged ? updated : messages;
}

/**
 * Settles the posted-question cards a message answered.
 *
 * The message record is the answer record — there is no second one per question
 * — so this is the only thing that ever moves a card from `pending` to
 * `answered` or `declined`. It guards on `pending`: a card something else has
 * already resolved keeps what resolved it, because that is what happened first
 * and nothing arriving later can know better.
 */
export function applyAnswering(
	messages: Message[],
	answering: QuestionAnswerRecord[],
): Message[] {
	const byRequest = new Map(answering.map((a) => [a.request_id, a]));
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;

		let changed = false;
		const updatedParts = msg.parts.map((part) => {
			if (part.type !== "question_record" || part.status !== "pending") {
				return part;
			}
			const answer = byRequest.get(part.record.requestId);
			if (!answer) return part;
			changed = true;
			const status: QuestionRecordStatus = answer.declined
				? "declined"
				: "answered";
			return { ...part, status, answer };
		});

		if (!changed) return msg;
		anyChanged = true;
		return { ...msg, parts: updatedParts };
	});
	return anyChanged ? updated : messages;
}

/**
 * Replays one {@link isBackReference} record over a page of older history.
 *
 * Every back-reference but one settles something and adds nothing, which is
 * what makes replaying them free. The exception is a message that answers
 * posted questions: the message itself belongs where it was written, a page
 * above, and only the half that settles the card is true down here.
 */
export function applyBackReference(
	messages: Message[],
	record: unknown,
): Message[] {
	const event = normalizeEvent(record as Record<string, unknown>);
	if (event.type === "message") {
		return event.answering
			? applyAnswering(messages, event.answering)
			: messages;
	}
	return applyServerEvent(messages, event);
}

/**
 * Settles the legacy cards a `question_response` record names.
 *
 * `answers` is the old flat shape: one string per question, keyed by question
 * text, with the labels picked joined by `", "` and any free text behind
 * `"Other: "`. It is parsed back into the halves a card draws with
 * ({@link parseAnswer}), so an old answer fills the form in exactly as a new one
 * does — which is the whole reason these records still go through the same
 * component. A null map is the CLI having cancelled its own question.
 */
function settleLegacyQuestion(
	messages: Message[],
	requestId: string,
	answers: Record<string, string> | null,
): Message[] {
	const isTarget = (part: ContentPart) =>
		part.type === "question_record" &&
		!!part.legacy &&
		part.record.requestId === requestId &&
		part.status === "pending";

	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;

		// How many questions the record being settled carried, which is what
		// lookupAnswer needs to decide whether a single unmatched entry can only be
		// this question's. Counted from the cards because that is where the record's
		// questions went — one card each — and getting it wrong the other way would
		// put one answer on all of them.
		const questionCount = msg.parts.filter(isTarget).length;

		let changed = false;
		const updatedParts = msg.parts.map((part) => {
			if (!isTarget(part) || part.type !== "question_record") return part;
			changed = true;
			if (answers === null) {
				return { ...part, status: "cancelled" as const };
			}
			const question = part.record.question;
			const flat = lookupAnswer(question, answers, questionCount);
			const selection = parseAnswer(flat, question.options);
			return {
				...part,
				status: "answered" as const,
				answer: {
					request_id: requestId,
					header: question.header,
					question: question.question,
					answers: selection.labels,
					...(selection.otherText ? { text: selection.otherText } : {}),
					// The old records carry no per-answer clock, and the card only
					// draws the question's own time. Left empty rather than filled in
					// with now, which would claim a moment that is not the answer's.
					answered_at: "",
				},
			};
		});

		if (!changed) return msg;
		anyChanged = true;
		return { ...msg, parts: updatedParts };
	});
	return anyChanged ? updated : messages;
}

/**
 * Records a run's outcome.
 *
 * An interrupted run keeps that status even though its result finally showed
 * up: the interrupt is a fact the result cannot undo. The content is still
 * kept, and a renderer says where it came from.
 *
 * The two background subtypes are why the reducer cannot simply read
 * `is_error`. A backgrounded call returns a placeholder immediately, so without
 * `background_started` a replayed transcript would show work still running as
 * successfully completed; `background_result` is the outcome that arrived after
 * the agent had moved on, and it supersedes the placeholder without erasing it
 * (docs/tool-call-model.md#background-lives-on-tool_result-twice).
 * `background_lost` is the same shape with a different author — Pockode saw the
 * process end — so it settles like `background_result` and differs only in the
 * text it carries.
 */
function settleToolRun(
	run: ToolRun,
	event: Extract<NormalizedEvent, { type: "tool_result" }>,
): ToolRun {
	const settled: ToolRun = {
		...run,
		...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
		...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
	};

	if (event.subtype === "background_started") {
		return {
			...settled,
			placeholderResult: event.toolResult,
			fromBackground: true,
			// Not a finished state: the work is still going, and only the badge
			// says the conversation moved on without it.
			status: run.status === "interrupted" ? "interrupted" : "background",
		};
	}

	const outcome: ToolRun = {
		...settled,
		result: event.toolResult,
		contents: event.contents,
		status:
			run.status === "interrupted"
				? "interrupted"
				: event.isError
					? "error"
					: "success",
	};

	if (
		event.subtype === "background_result" ||
		event.subtype === "background_lost"
	) {
		return {
			...outcome,
			// Set here rather than inherited from the `background_started` that
			// normally precedes it: `task_updated` may backdate a call into a
			// background task *after* its placeholder was already parsed, and
			// then nothing marked the run. Both subtypes only ever describe a
			// backgrounded call, so they can say so themselves.
			fromBackground: true,
			// The row's second line hands over from the live activity to the
			// outcome here, so the row settles without changing height.
			activity: undefined,
		};
	}
	return outcome;
}

/**
 * Applies `update` to the run this record names, wherever in the transcript it
 * is — a background outcome arrives turns later, and a result that outlived an
 * interrupt lands back in the turn that started it.
 *
 * Two passes, and the order matters: an existing row anywhere wins over
 * rebuilding one from a permission card, so a call whose card somehow sits in a
 * later turn than its row cannot end up drawn twice.
 *
 * Rebuilding is what keeps an approved call visible at all. Measured against
 * claude 2.1.263: the `tool_call` arrives before the approval request and is
 * *not* re-sent afterwards, so once the card has taken the pending row's place
 * — which it does because the machine is then waiting for the user, not working
 * — the card is all that is left of the call. The row is rebuilt from what the
 * card itself carries, directly under it, which is where it was. It gets no
 * `seenAt`: the call started before this client could see it start, and a
 * stopwatch begun here would be counting the wrong thing.
 *
 * Returns the list unchanged when the record names no call on screen — an
 * orphan result, or progress for a call whose page is not loaded.
 */
function updateRunById(
	messages: Message[],
	toolUseId: string,
	update: (run: ToolRun) => ToolRun,
	/**
	 * Whether a card still pending may be given a row. False for progress: while
	 * the user is deciding, nothing about this call is running, and a spinner
	 * above the card would say the machine is busy when it is waiting for them.
	 * A result is the engine acting, so it gets its row either way — including
	 * the refusal text a denial produces, which lands as an ordinary settled run
	 * under the card that already said why.
	 */
	fromPendingCard = true,
): Message[] {
	// Nothing to join to. History is old enough to hold records written before
	// every adapter carried the id, and an empty one would match the first part
	// that also has none — rebuilding a row for a call that is not this one.
	if (!toolUseId) return messages;

	const write = (
		message: AssistantMessage,
		index: number,
		parts: ContentPart[],
		partIndex: number,
	): Message[] => {
		const part = parts[partIndex];
		if (part.type !== "tool_call") return messages; // Type guard - never happens
		const run = update(part.tool);
		// Handing back the same run says the record changed nothing — progress on
		// a call that has already settled. The list is returned untouched, so a
		// transcript that did not change does not re-render.
		if (run === part.tool && parts === message.parts) return messages;

		const updatedParts = [...parts];
		updatedParts[partIndex] = { ...part, tool: run };
		const updated = [...messages];
		updated[index] = { ...message, parts: updatedParts };
		return updated;
	};

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const partIndex = findToolRunIndex(msg.parts, toolUseId);
		if (partIndex !== -1) return write(msg, i, msg.parts, partIndex);
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const cardIndex = msg.parts.findIndex(
			(part) =>
				part.type === "permission_request" &&
				part.request.toolUseId === toolUseId &&
				(fromPendingCard || part.status !== "pending"),
		);
		if (cardIndex === -1) continue;

		const card = msg.parts[cardIndex];
		if (card.type !== "permission_request") continue; // Type guard - never happens
		const restored: ContentPart = {
			type: "tool_call",
			tool: {
				id: toolUseId,
				name: card.request.toolName,
				input: card.request.toolInput,
				status: "running",
			},
		};
		const parts = [...msg.parts];
		parts.splice(cardIndex + 1, 0, restored);
		return write(msg, i, parts, cardIndex + 1);
	}

	return messages;
}

/**
 * Files a call that reads an earlier call's task under that call, and returns
 * null when no row for it is loaded.
 *
 * Decided once, here, as the call arrives — never re-decided when its result
 * does. The `tool_call` comes first and its `tool_result` seconds later, so a
 * rule that waited for the result would draw a row and then take it away again,
 * and a row disappearing under the user is what the transcript may never do
 * (docs/tool-call-ui.md). By the same token a fetch that kept its own row keeps
 * it for good: paging backwards may bring the origin row into view afterwards,
 * and the row above it does not then go and move.
 */
function absorbFetchCall(
	messages: Message[],
	originToolUseId: string,
	fetchToolUseId: string,
): Message[] | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const partIndex = findToolRunIndex(msg.parts, originToolUseId);
		if (partIndex === -1) continue;

		const part = msg.parts[partIndex];
		if (part.type !== "tool_call") continue; // Type guard - never happens
		const run = part.tool;
		// Already filed — the same call announced twice. Absorbed all the same:
		// what this returns is the absence of a row, not an entry.
		if (run.fetches?.some((fetch) => fetch.id === fetchToolUseId)) {
			return messages;
		}

		const parts = [...msg.parts];
		parts[partIndex] = {
			...part,
			tool: {
				...run,
				fetches: [...(run.fetches ?? []), { id: fetchToolUseId }],
			},
		};
		const updated = [...messages];
		updated[i] = { ...msg, parts };
		return updated;
	}
	return null;
}

/**
 * Records what a fetch brought back, on the run it was filed under.
 *
 * This is the whole of how the reducer remembers an absorbed call: the entry
 * `absorbFetchCall` left behind is the mapping from the fetching call's id back
 * to the run, so its result — which names only its own call — still has
 * somewhere to go. Written by id rather than appended, so the same record
 * replayed with a second page of history updates the entry instead of doubling
 * it.
 *
 * Returns null when this result names no fetch, which is every ordinary result
 * and also a fetch that kept its own row.
 */
function applyFetchResult(
	messages: Message[],
	event: Extract<NormalizedEvent, { type: "tool_result" }>,
): Message[] | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const partIndex = msg.parts.findIndex(
			(part) =>
				part.type === "tool_call" &&
				part.tool.fetches?.some((fetch) => fetch.id === event.toolUseId),
		);
		if (partIndex === -1) continue;

		const part = msg.parts[partIndex];
		if (part.type !== "tool_call") continue; // Type guard - never happens
		const fetched: ToolFetch = {
			id: event.toolUseId,
			result: event.toolResult,
			...(event.contents ? { contents: event.contents } : {}),
			// The fetch failed, not the task it was reading: the run keeps its own
			// status, and only this entry says anything went wrong.
			...(event.isError ? { isError: true } : {}),
		};
		const parts = [...msg.parts];
		parts[partIndex] = {
			...part,
			tool: {
				...part.tool,
				fetches: part.tool.fetches?.map((fetch) =>
					fetch.id === event.toolUseId ? fetched : fetch,
				),
			},
		};
		const updated = [...messages];
		updated[i] = { ...msg, parts };
		return updated;
	}
	return null;
}

function updateToolResult(
	messages: Message[],
	event: Extract<NormalizedEvent, { type: "tool_result" }>,
): Message[] {
	// A fetch's own id names no row — its call was absorbed — so it is looked up
	// among the fetches before the rows.
	return (
		applyFetchResult(messages, event) ??
		updateRunById(messages, event.toolUseId, (run) => settleToolRun(run, event))
	);
}

/**
 * How much of a running call's output is kept.
 *
 * The row reads its last non-empty line and the body its last 50, so older
 * lines are only ever read again by a `Bash` that prints a hundred thousand of
 * them into a transcript that stays open for hours. The whole output arrives
 * again with the result.
 */
const MAX_LIVE_OUTPUT_LINES = 200;

function appendOutput(previous: string | undefined, delta: string): string {
	const combined = (previous ?? "") + delta;
	const lines = combined.split("\n");
	return lines.length <= MAX_LIVE_OUTPUT_LINES
		? combined
		: lines.slice(-MAX_LIVE_OUTPUT_LINES).join("\n");
}

/**
 * Applies what a call still in flight reports it is doing.
 *
 * Ignored for a run that has settled: updates are coalesced per animation
 * frame, so one held back may be applied after the result, and a progress line
 * under a finished row is worse than a moment of missing liveness.
 */
function updateToolActivity(
	messages: Message[],
	event: Extract<NormalizedEvent, { type: "tool_activity" }>,
): Message[] {
	return updateRunById(
		messages,
		event.toolUseId,
		(run) => {
			if (run.status !== "running" && run.status !== "background") return run;
			return {
				...run,
				// An empty activity leaves the last one standing: a line that
				// blinks in and out re-flows every row below it.
				...(event.activity ? { activity: event.activity } : {}),
				...(event.outputDelta
					? { output: appendOutput(run.output, event.outputDelta) }
					: {}),
			};
		},
		false,
	);
}

/**
 * The newest activity of every call still in flight, as a mid-run subscription
 * hands it back. Applied over a replayed transcript, which has none of its own:
 * a `tool_activity` is never recorded.
 */
export function applyToolActivitySnapshot(
	messages: Message[],
	activity: Record<string, string>,
): Message[] {
	let updated = messages;
	for (const [toolUseId, text] of Object.entries(activity)) {
		updated = updateToolActivity(updated, {
			type: "tool_activity",
			toolUseId,
			activity: text,
		});
	}
	return updated;
}

/**
 * Marks runs still running as interrupted, for use when nothing can report
 * back on them any more (the turn was cut short, or the process is gone).
 * Leaving them running would spin a Spinner that never stops.
 *
 * A `background` run is deliberately left alone: its work outlives the turn by
 * definition, and its outcome is still coming.
 */
function settleRunningToolParts(parts: ContentPart[]): ContentPart[] {
	let changed = false;
	const updated = parts.map((part) => {
		if (part.type !== "tool_call" || part.tool.status !== "running")
			return part;
		changed = true;
		return { ...part, tool: { ...part.tool, status: "interrupted" as const } };
	});
	return changed ? updated : parts;
}

export function settleRunningToolRuns(messages: Message[]): Message[] {
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;
		const parts = settleRunningToolParts(msg.parts);
		if (parts === msg.parts) return msg;
		anyChanged = true;
		return { ...msg, parts };
	});
	return anyChanged ? updated : messages;
}

interface UserMessageOptions {
	source?: MessageOrigin;
	subtype?: string;
	meta?: SystemMessageMeta;
	anchorSeq?: HistorySeq;
	/** The posted questions this message answers; see QuestionAnswerRecord. */
	answering?: QuestionAnswerRecord[];
}

/**
 * True for an assistant bubble that would render as an empty box: it holds no
 * content, and its status has nothing to say either.
 *
 * `interrupted`, `error` and `process_ended` are deliberately excluded — those
 * carry their whole message in the status line, so a missing body is exactly
 * when they matter most. Dropping them would hide an aborted turn from the
 * user.
 */
function isEmptyPlaceholder(message: Message): boolean {
	return (
		message.role === "assistant" &&
		message.parts.length === 0 &&
		message.status === "complete"
	);
}

// Declares that nothing is running any more: every bubble still open is settled
// as `complete`, and the ones the agent never wrote into are dropped rather than
// left as blank bubbles.
//
// Called where something other than a turn's own ending says the turn is over:
// a message arriving at an idle agent (`appendUserMessage`), and a page of
// history whose last turn ended in the page above it (`prependHistoryPage`). A
// turn that is genuinely still running is never put through here — a message
// sent into one joins it instead.
function closePreviousTurn(messages: Message[]): Message[] {
	return messages
		.map((m): Message => {
			if (
				m.role === "assistant" &&
				(m.status === "sending" || m.status === "streaming")
			) {
				return { ...m, status: "complete" };
			}
			return m;
		})
		.filter((m) => !isEmptyPlaceholder(m));
}

/**
 * Puts a message the agent is being given at the end of the transcript, in one
 * of the two shapes a message can take:
 *
 * - **Nothing running.** The message opens a turn, so whatever the agent was
 *   mid-way through is closed out and `placeholder()` is left behind for the
 *   reply it provokes.
 * - **A turn running.** The message was sent into that turn — the CLIs steer the
 *   running turn with whatever arrives mid-reply — so the reply above keeps
 *   growing where it is and the message is simply appended below it. No
 *   placeholder is made, and `placeholder()` is not called: the reply to *this*
 *   message, if the agent writes a separate one, opens its own bubble once the
 *   turn ends. The bubble that is missing here is what `useChatMessages` reads
 *   back as "sent while the agent was working", so do not add one.
 *
 * Both callers come through here — the broadcast path below and the local
 * optimistic echo in `useChatMessages`, which needs to name the two messages it
 * appends so it can stamp a seq onto one and a failure onto the other. Writing
 * the rule once is the point: the two paths drifting apart is exactly how the
 * transcript starts claiming one turn's output answered another turn's message.
 */
export function appendUserMessage(
	messages: Message[],
	userMessage: UserMessage,
	placeholder: () => AssistantMessage,
): Message[] {
	if (openAssistantIndex(messages) >= 0) return [...messages, userMessage];
	return [...closePreviousTurn(messages), userMessage, placeholder()];
}

/** `appendUserMessage` for a message arriving as a record, which names nothing. */
export function applyUserMessage(
	messages: Message[],
	content: string,
	options?: UserMessageOptions,
): Message[] {
	const userMessage: UserMessage = {
		id: generateUUID(),
		role: "user",
		content,
		status: "complete",
		createdAt: new Date(),
		...(options?.anchorSeq !== undefined
			? { anchorSeq: options.anchorSeq }
			: {}),
		// Only tag the messages a person did not type; a plain user message stays
		// source-less. An agent's answer carries no subtype or meta — what there
		// is to say about it is on the answers themselves.
		...(options?.source === "system"
			? { source: options.source, subtype: options.subtype, meta: options.meta }
			: {}),
		...(options?.source === "agent" ? { source: options.source } : {}),
		...(options?.answering ? { answering: options.answering } : {}),
	};

	return appendUserMessage(messages, userMessage, () =>
		createAssistantMessage(),
	);
}

/**
 * Record types that settle something recorded earlier rather than adding to the
 * transcript: a tool result naming its call, an answer naming its question, a
 * process end retiring every dialog still open.
 *
 * They are the reason a page of history cannot be read on its own. A page holds
 * the conversation as it stood at that moment, so a call answered one page later
 * replays as still running. A client that pages backwards keeps these aside and
 * replays them over each older page it pulls in — they are all idempotent
 * "update wherever it is" operations, so replaying them costs nothing when the
 * target is not there.
 */
const BACK_REFERENCE_TYPES = new Set([
	"tool_result",
	"permission_response",
	"question_response",
	"request_cancelled",
	"process_ended",
]);

/**
 * Retires everything that can no longer report back now that the session's
 * process is gone. Needed wherever history does not say so itself: the server
 * writes a `process_ended` for a session its restart cut short, but a session
 * stored by a build from before that repair existed has none, so replay can
 * still reach the end of a transcript with dialogs open.
 */
export function settleAfterProcessGone(messages: Message[]): Message[] {
	// The reason is the record itself: every card still open when a process ends
	// lost the only thing that could have taken its answer.
	return settleRunningToolRuns(
		expirePendingDialogs(messages, undefined, "process_ended"),
	);
}

/**
 * Retires what the session's turn says can no longer report back: a pending card
 * it does not list as a blocker has lost the process that would have taken its
 * answer, and a tool call still running has nothing left to report once the turn
 * is idle. A card the turn *does* list is still answerable and is left alone,
 * which is why this reads the blockers rather than a boolean.
 *
 * While the turn is blocked or running the process is alive, so a call in flight
 * may yet come back and is not settled.
 *
 * Safe on any page of a transcript: neither settlement claims anything about
 * *when* the turn ended, only that it is over now.
 */
export function retireAgainstTurn(
	messages: Message[],
	turn: SessionTurn,
): Message[] {
	const liveRequests = new Set(
		(turn.blockers ?? [])
			.map((blocker) => blocker.request_id)
			.filter((id): id is string => id !== undefined),
	);

	// No reason: the turn says which prompts are still live, not why the others
	// stopped being so. The records that do know say it themselves.
	const retired = expirePendingDialogs(messages, liveRequests);
	return turn.phase === "idle" ? settleRunningToolRuns(retired) : retired;
}

/**
 * Closes the newest page of a transcript out against what the session says it is
 * doing (docs/lifecycle-ui.md §2.4).
 *
 * This is the only thing that finishes a transcript whose server died
 * mid-stream. History cannot do it on its own: the run that was killed had no
 * chance to write anything, and a session stored by a build from before the
 * restart repair existed has no `process_ended` record at all — so replay can
 * reach the end of a transcript with a bubble still streaming and dialogs still
 * open. The turn is the authority those records are missing.
 *
 * On top of the retirements above: a bubble still `streaming` while the turn is
 * not running has stopped, and it stopped the way the turn ended. A turn parked
 * on a background task counts — nothing is arriving, and saying so is the whole
 * point of that blocker.
 *
 * Only the newest page, because `last_outcome` is how the *last* turn ended and
 * an older page's unfinished turn is not that one. Older pages are closed by
 * `prependHistoryPage`, which knows a page's last turn is over without knowing
 * how.
 */
export function settleAgainstTurn(
	messages: Message[],
	turn: SessionTurn,
): Message[] {
	const retired = retireAgainstTurn(messages, turn);
	if (turn.phase === "running") return retired;
	return finalizeStreamingMessages(
		retired,
		turn.last_outcome === "aborted" ? "interrupted" : "complete",
	);
}

/** Gives every bubble still `streaming` the status the turn ended with. */
function finalizeStreamingMessages(
	messages: Message[],
	status: "interrupted" | "complete",
): Message[] {
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant" || msg.status !== "streaming") return msg;
		anyChanged = true;
		return { ...msg, status };
	});
	return anyChanged ? updated : messages;
}

export function isBackReference(record: unknown): boolean {
	const fields = record as Record<string, unknown> | null;
	const type = fields?.type;
	// A message is kept for one half of itself only: the questions it answers
	// may have been asked pages below. An ordinary message settles nothing and
	// must never be replayed, which would put a second copy of it on screen —
	// see applyBackReference for how the two halves are told apart.
	if (type === "message") {
		return Array.isArray(fields?.answering) && fields.answering.length > 0;
	}
	return typeof type === "string" && BACK_REFERENCE_TYPES.has(type);
}

/**
 * Record types that end a turn rather than adding to it.
 *
 * One of these opening a page has nothing in that page to end — the turn it
 * ended trails off at the bottom of the page below — so replaying that page
 * alone learns nothing from it. It is the boundary terminal of the page below
 * and is handed to {@link prependHistoryPage} when that page arrives.
 */
const TURN_TERMINAL_TYPES = new Set([
	"interrupted",
	"process_ended",
	"done",
	"error",
]);

export function isTurnTerminal(record: unknown): boolean {
	const type = (record as Record<string, unknown> | null)?.type;
	return typeof type === "string" && TURN_TERMINAL_TYPES.has(type);
}

/** Rejoins the parts of one turn that a page boundary split in two. */
function joinTurnParts(
	before: ContentPart[],
	after: ContentPart[],
): ContentPart[] {
	// Through the same rule the stream itself uses, so a sentence — or a fenced
	// code block — cut in two by the boundary comes back as one part rather than
	// two that render side by side.
	const first = after[0];
	return first?.type === "text"
		? [
				...applyEventToParts(before, {
					type: "text",
					content: first.content,
				}),
				...after.slice(1),
			]
		: [...before, ...after];
}

/** What a page could not know had happened to it after it was written. */
interface HistoryPageCatchUp {
	/**
	 * The record that immediately follows this page, when it is one
	 * {@link isTurnTerminal} keeps. Opening the page above it had nothing to end
	 * and was dropped there; the turn it did end is the one this page trails off
	 * on, so it is replayed here before that turn is closed.
	 */
	boundaryTerminal?: unknown;
	/**
	 * Records kept by {@link isBackReference} from every page already loaded,
	 * oldest first.
	 */
	backReferences?: unknown[];
	/**
	 * What the session is doing now. This page's history does not say, and the
	 * dialogs and tool calls it left open may be ones nothing can still report
	 * back on — see {@link retireAgainstTurn}.
	 */
	turn?: SessionTurn;
}

/**
 * Splices a page of older history in front of what is already on screen.
 *
 * A page boundary falls between two records, not between two turns, so the turn
 * the cut lands in comes back as two halves: the older page trails off mid-turn,
 * and the page above it opened on content that no message event preceded. The
 * reducer has only one way to produce a leading assistant message — that exact
 * orphan case — which is what makes rejoining the two halves safe.
 */
export function prependHistoryPage(
	older: Message[],
	current: Message[],
	catchUp: HistoryPageCatchUp = {},
): Message[] {
	// The record that ended this page's last turn goes first, while that turn is
	// still the streaming one: it is the only record that may say how the turn
	// ended, and applying it after the turn has been closed would be a no-op.
	let closed = older;
	if (catchUp.boundaryTerminal) {
		const record = catchUp.boundaryTerminal as Record<string, unknown>;
		// With its seq, unlike the back-references: this record is the last of the
		// turn it ends, so it is the point a fork of that turn has to cut at — the
		// address replaying the whole history unbroken would have left there.
		closed = applyServerEvent(
			closed,
			normalizeEvent(record),
			readHistorySeq(record),
		);
	}

	// The older page's last turn is over by definition: the records that ended it
	// are in the page above. Left as it replayed, it would keep a spinner running
	// forever in the middle of the transcript. This is also what stands in when
	// the boundary terminal says nothing — a turn cut mid-answer by the page size
	// ended no particular way.
	//
	// Closing it *before* replaying the back-references is what keeps a later
	// `process_ended` from stamping its own status onto a turn that was still
	// running at this point in the transcript: with nothing left streaming it
	// retires only the dialogs and tool calls this page left open, which is the
	// part of it that is true here.
	closed = closePreviousTurn(closed);
	for (const record of catchUp.backReferences ?? []) {
		closed = applyBackReference(closed, record);
	}
	if (catchUp.turn) {
		closed = retireAgainstTurn(closed, catchUp.turn);
	}
	if (closed.length === 0) return current;

	const tail = closed[closed.length - 1];
	const head = current[0];
	if (tail.role !== "assistant" || head?.role !== "assistant") {
		return [...closed, ...current];
	}

	// A turn that already ended this way keeps the status it ended with, and what
	// trails it is late content that cannot reopen it — the same rule applyEvent
	// follows when the two halves arrive in one stream. `complete` is excluded
	// there too, so the head's status stands for it.
	const endedAtBoundary =
		tail.status === "interrupted" ||
		tail.status === "error" ||
		tail.status === "process_ended";
	const joined = joinTurnParts(tail.parts, head.parts);

	const merged: AssistantMessage = {
		// Keeps the head's identity rather than the tail's: MessageList keys on it,
		// so adopting the older id would remount the bubble and throw away whatever
		// the user had expanded inside it. Load-bearing outside this file too: it is
		// why the transcript pins its scroll position one message below the head
		// rather than to it (docs/agent-chat.md#reading-a-page-on-the-client).
		...head,
		...(endedAtBoundary ? { status: tail.status, error: tail.error } : {}),
		parts: endedAtBoundary ? settleRunningToolParts(joined) : joined,
		createdAt: tail.createdAt,
		// The head's anchor wins when it has one: it names the later record, which
		// is where a fork of this message has to cut.
		...(head.anchorSeq === undefined && tail.anchorSeq !== undefined
			? { anchorSeq: tail.anchorSeq }
			: {}),
	};
	return [...closed.slice(0, -1), merged, ...current.slice(1)];
}

export function replayHistory(records: unknown[]): Message[] {
	let messages: Message[] = [];

	for (const record of records) {
		const raw = record as Record<string, unknown>;
		messages = applyServerEvent(
			messages,
			normalizeEvent(raw),
			readHistorySeq(raw),
		);
	}

	return messages;
}
