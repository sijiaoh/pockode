import type { ContentBlock, FileBlock } from "../types/content";
import type {
	AskUserQuestion,
	AssistantMessage,
	ContentPart,
	ExpiryReason,
	HistorySeq,
	Message,
	MessageOrigin,
	PermissionUpdate,
	PockodeCommandInvocation,
	QuestionAnswerRecord,
	QuestionRecordStatus,
	ServerNotification,
	SessionTurn,
	SystemMessageMeta,
	Thought,
	ToolFetch,
	ToolRun,
	UserMessage,
} from "../types/message";
import type { AgentType } from "../types/settings";
import { lookupAnswer, parseAnswer } from "../utils/questionAnswer";
import { generateUUID } from "../utils/uuid";
import { AGENT_TYPES } from "./agentType";
import { parseContentBlocks, parseFileBlocks } from "./contentBlocks";
import {
	editAtPath,
	editChildrenAtPath,
	findPartPath,
	findToolRunPath,
	mapPartsDeep,
	type PartPath,
} from "./partTree";
import { isDrawnThought } from "./thinking";

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

// The CLI a record says refused its credentials. An agent this build does not
// know reads as no mark: the record then renders as an ordinary error or
// warning, which is true of it, rather than offering a sign-in to nothing.
function normalizeAuthFailure(raw: unknown): AgentType | undefined {
	const agent = (raw as { agent?: unknown } | null | undefined)?.agent;
	return AGENT_TYPES.find((type) => type === agent);
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

// A message record's `command`, kept only when it names one: anything else
// would draw a command row with no command in it. Also reads the same field on
// the `chat.message` reply.
export function normalizeCommand(
	raw: unknown,
): PockodeCommandInvocation | undefined {
	const fields = raw as Record<string, unknown> | null | undefined;
	if (typeof fields?.name !== "string" || !fields.name) return undefined;
	return typeof fields.args === "string" && fields.args
		? { name: fields.name, args: fields.args }
		: { name: fields.name };
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
	| {
			type: "text";
			content: string;
			/**
			 * The subagent call this was produced inside; absent for the main
			 * conversation. The call it names may not be loaded.
			 */
			parentToolUseId?: string;
	  }
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
			/** See the `text` event. */
			parentToolUseId?: string;
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
	| {
			/** A finished stretch of thinking; see the wire record. */
			type: "thinking";
			/** `durationMs` is absent when nothing measured it — never zero. */
			thought: Thought;
			parentToolUseId?: string;
	  }
	| {
			/** The main agent is thinking now; never persisted. */
			type: "thinking_delta";
			contentDelta: string;
			fullReasoningDelta: string;
	  }
	| {
			type: "warning";
			message: string;
			code: string;
			/** See `ContentPart`'s warning. */
			authFailure?: AgentType;
	  }
	| { type: "error"; error: string; authFailure?: AgentType }
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
			/** See `UserMessage.messageId`. */
			messageId?: string;
			origin?: MessageOrigin;
			subtype?: string;
			meta?: SystemMessageMeta;
			/** The posted questions this message answers; see QuestionAnswerRecord. */
			answering?: QuestionAnswerRecord[];
			/** The Pockode command `content` was expanded from. */
			command?: PockodeCommandInvocation;
			/** The files the user sent with the message. */
			attachments?: FileBlock[];
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
	| {
			/**
			 * The agent has read a message sent into a turn that was already
			 * running. A boundary and nothing else — it carries no content and
			 * draws nothing.
			 */
			type: "message_ingested";
	  }
	| {
			/**
			 * A Stop threw the message named away unread. Draws nothing in the
			 * transcript by itself; it is filed on the turn it ended.
			 */
			type: "message_discarded";
			messageId: string;
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
			return {
				type: "text",
				content: (record.content as string) ?? "",
				parentToolUseId: record.parent_tool_use_id as string | undefined,
			};
		case "tool_call":
			return {
				type: "tool_call",
				toolUseId: record.tool_use_id as string,
				toolName: record.tool_name as string,
				toolInput: record.tool_input,
				originToolUseId: record.origin_tool_use_id as string | undefined,
				parentToolUseId: record.parent_tool_use_id as string | undefined,
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
				// No `parent_tool_use_id`: a result joins its call by id at any
				// depth, so whose call it was is already known where it lands.
			};
		case "tool_activity":
			return {
				type: "tool_activity",
				toolUseId: record.tool_use_id as string,
				activity: record.activity as string | undefined,
				outputDelta: record.output_delta as string | undefined,
			};
		case "thinking":
			return {
				type: "thinking",
				thought: {
					content: (record.content as string) ?? "",
					fullReasoning: (record.full_reasoning as string) ?? "",
					redacted: record.redacted === true,
					...(typeof record.duration_ms === "number" && record.duration_ms > 0
						? { durationMs: record.duration_ms }
						: {}),
				},
				parentToolUseId: record.parent_tool_use_id as string | undefined,
			};
		case "thinking_delta":
			return {
				type: "thinking_delta",
				contentDelta: (record.content_delta as string) ?? "",
				fullReasoningDelta: (record.full_reasoning_delta as string) ?? "",
			};
		case "warning":
			return {
				type: "warning",
				message: (record.message as string) ?? "",
				code: (record.code as string) ?? "",
				authFailure: normalizeAuthFailure(record.auth_failure),
			};
		case "error":
			return {
				type: "error",
				error: (record.error as string) ?? "",
				authFailure: normalizeAuthFailure(record.auth_failure),
			};
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
				...(typeof record.message_id === "string" && record.message_id
					? { messageId: record.message_id }
					: {}),
				origin: normalizeOrigin(record.origin),
				subtype: record.subtype as string | undefined,
				meta: record.meta as SystemMessageMeta | undefined,
				answering: normalizeAnswering(record.answering),
				command: normalizeCommand(record.command),
				attachments: parseFileBlocks(record.attachments),
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
		case "message_ingested":
			// `message_id` is dropped here rather than carried and ignored
			// downstream: nothing in the transcript is joined on it (see
			// `applyEvent`), and a field nobody reads is a field the next reader
			// has to prove nobody reads.
			return { type: "message_ingested" };
		case "message_discarded":
			return {
				type: "message_discarded",
				messageId: (record.message_id as string) ?? "",
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
 * The `question_post` tool row a `question_posted` record belongs to, or null.
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
function openQuestionPostPath(parts: ContentPart[]): PartPath | null {
	// At any depth: a subagent can post a question too, and its call is then in
	// that subagent's children. Which of two open calls from different agents
	// is "last" is the limit this join always had (docs/tool-call-ui.md).
	return findPartPath(
		parts,
		(part) =>
			part.type === "tool_call" &&
			part.tool.status === "running" &&
			part.tool.name.endsWith("question_post"),
	);
}

/**
 * The last card of the batch a `question_posted` record belongs to, or null.
 *
 * A batch is the questions of one `question_post` call, and the server stamps
 * all of them with the one `asked_at` and writes them back to back, so the
 * time is what names it. Two calls landing on one tick of a coarse clock read
 * as one batch, which costs little: their questions stay in order, and the
 * second call's row is left drawn beside them. A record without a time
 * predates batches and belongs to none.
 */
function lastOfBatchPath(
	parts: ContentPart[],
	askedAt: string | undefined,
): PartPath | null {
	if (!askedAt) return null;
	return findPartPath(
		parts,
		(part) =>
			part.type === "question_record" && part.record.askedAt === askedAt,
	);
}

function applyToolCall(
	parts: ContentPart[],
	toolUseId: string,
	toolName: string,
	toolInput: unknown,
	options: ApplyOptions,
	parentToolUseId?: string,
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
	const cardIndex = parts.findIndex(
		(part) =>
			part.type === "permission_request" &&
			part.request.toolUseId === toolUseId &&
			part.status === "pending",
	);
	if (cardIndex !== -1) {
		// A subagent's card that came before its call, and whose call could not
		// be filed either: the call is the one to say whose it is, and the card
		// standing in for it keeps that, as a card replacing a row does.
		const card = parts[cardIndex];
		if (!parentToolUseId || card.type !== "permission_request") return parts;
		if (card.parentToolUseId) return parts;
		const updated = [...parts];
		updated[cardIndex] = { ...card, parentToolUseId };
		return updated;
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
			...(parentToolUseId ? { parentToolUseId } : {}),
		},
	];
}

/**
 * `card` taking the place of `row`, keeping whose call it was. Only an
 * unfiled row says so — a filed one is placed — and losing it would drop the
 * call from its subagent's count, and give the row rebuilt on approval to the
 * main agent.
 */
function withParentOf(row: ContentPart, card: ContentPart): ContentPart {
	if (row.type !== "tool_call" || !row.parentToolUseId) return card;
	if (card.type !== "permission_request" && card.type !== "question_record") {
		return card;
	}
	return { ...card, parentToolUseId: row.parentToolUseId };
}

export function applyEventToParts(
	parts: ContentPart[],
	event: NormalizedEvent,
	options: ApplyOptions = {},
): ContentPart[] {
	switch (event.type) {
		case "text": {
			// Joined only with text from the same speaker: a subagent's words that
			// could not be filed sit flat beside the main agent's, and run together
			// they would be one paragraph nobody could attribute.
			//
			// A record is a whole message, not a delta — neither adapter streams
			// partial text — so two of them are two paragraphs. Back to back is the
			// ordinary case once subagent work is filed away: the main agent's "A
			// and B are running" and its "A finished" used to have that work
			// between them, and joined bare they read as one run-on sentence.
			const lastPart = parts[parts.length - 1];
			if (
				lastPart?.type === "text" &&
				lastPart.parentToolUseId === event.parentToolUseId
			) {
				return [
					...parts.slice(0, -1),
					{ ...lastPart, content: `${lastPart.content}\n\n${event.content}` },
				];
			}
			return [
				...parts,
				{
					type: "text",
					content: event.content,
					...(event.parentToolUseId
						? { parentToolUseId: event.parentToolUseId }
						: {}),
				},
			];
		}
		case "tool_call":
			return applyToolCall(
				parts,
				event.toolUseId,
				event.toolName,
				event.toolInput,
				options,
				event.parentToolUseId,
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
			// At any depth: a subagent's call is asked about where it is filed,
			// and the renderer decides where a pending card is drawn.
			const path = event.toolUseId
				? findToolRunPath(parts, event.toolUseId)
				: null;
			if (!path) return [...parts, permissionPart];

			return editAtPath(parts, path, (list, index) => {
				const updated = [...list];
				updated[index] = withParentOf(list[index], permissionPart);
				return updated;
			});
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
			//
			// One call can post several questions, one record each, and only the
			// first finds the row: the rest go in right behind their batch, which
			// may no longer be at the end — a parallel tool call drawn after the
			// row, or the row of a second open `question_post`, would otherwise
			// split the batch or take one of its questions out of order.
			const batchEnd = lastOfBatchPath(parts, event.askedAt);
			if (batchEnd) {
				return editAtPath(parts, batchEnd, (list, index) => {
					const updated = [...list];
					updated.splice(index + 1, 0, questionPart);
					return updated;
				});
			}
			const path = openQuestionPostPath(parts);
			if (!path) return [...parts, questionPart];

			return editAtPath(parts, path, (list, index) => {
				const updated = [...list];
				updated[index] = withParentOf(list[index], questionPart);
				return updated;
			});
		}
		case "thinking": {
			const { thought } = event;
			// Joined like text, and only with the same speaker's: consecutive
			// records are one pause the engine happened to split, and one row.
			const lastPart = parts[parts.length - 1];
			if (
				lastPart?.type === "thinking" &&
				lastPart.parentToolUseId === event.parentToolUseId
			) {
				return [
					...parts.slice(0, -1),
					{ ...lastPart, thoughts: [...lastPart.thoughts, thought] },
				];
			}
			return [
				...parts,
				{
					type: "thinking",
					id: generateUUID(),
					thoughts: [thought],
					...(event.parentToolUseId
						? { parentToolUseId: event.parentToolUseId }
						: {}),
				},
			];
		}
		case "system":
			return [...parts, { type: "system", content: event.content }];
		case "warning":
			return [
				...parts,
				{
					type: "warning",
					message: event.message,
					code: event.code,
					authFailure: event.authFailure,
				},
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

/** Whether a bubble's turn was cut short rather than finished. */
function isAbortedStatus(message: Message): boolean {
	return (
		message.role === "assistant" &&
		(message.status === "interrupted" ||
			message.status === "error" ||
			message.status === "process_ended")
	);
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
 * tail line nothing could end.
 *
 * At most one bubble is ever open, so scanning past closed ones cannot pick the
 * wrong turn: content opens a bubble only when this returns -1, and the one
 * thing that opens one regardless — a read point — closes the open one in the
 * same step.
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
	// is then an old one that this record did not touch. A card can also take
	// its bubble out from the middle (`takeStrayCard`), shifting everything after
	// it, so a last message `before` already held is one this record left alone.
	if (last === before[index]) return after;
	if (after.length < before.length && before.includes(last)) return after;

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
			? applyAnswering(messages, event.answering, event.messageId)
			: messages;
		// Stamped inside applyUserMessage rather than by stampAnchorSeq: when the
		// message opens a turn it is followed by an empty assistant placeholder, so
		// the last element is not the one holding the record.
		return applyUserMessage(settled, event.content, {
			messageId: event.messageId,
			source: event.origin,
			subtype: event.subtype,
			meta: event.meta,
			anchorSeq: seq,
			answering: event.answering,
			command: event.command,
			attachments: event.attachments,
		});
	}

	// Not the transcript's: the tail line draws it from state of its own
	// (useChatMessages), and nothing is placed for it here — it would open an
	// empty reply.
	if (event.type === "thinking_delta") {
		return messages;
	}

	// A thinking that would draw nothing is set aside before it can open a
	// reply, or join a run and cost its sum the number.
	if (event.type === "thinking" && !isDrawnThought(event.thought)) {
		return messages;
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

	// The read point: the agent has picked up a message that was sent into this
	// turn, so the bubble it was writing is finished and what it writes next
	// answers that message. One rule, whichever CLI is behind it — the server
	// decides when the record is written and this never asks which engine wrote
	// it (docs/code/agent-integration.md#the-read-point).
	//
	// The bubble is opened here rather than left to the next content event so
	// that the tail line survives the cut and the "not read yet" line above the
	// composer goes at the right moment (AttentionStrip). It cannot leave a
	// blank box: an empty bubble is dropped when the turn ends, including the
	// one this replaces.
	//
	// It goes at the end, and the record's `message_id` is deliberately not used
	// to place it — records apply in order, so the end already is under the
	// message that was read, and the client that sent that message learns its
	// id only from the reply to its send, which may come later than this record
	// (docs/code/frontend-state.md).
	//
	// Unconditional, with nothing tested first: a page of history can begin at a
	// read point, and there the bubble being cut is in the page below and there
	// is nothing open to find. `openedAtReadPoint` is how `prependHistoryPage`
	// then knows not to join the two pages back together.
	if (event.type === "message_ingested") {
		return [
			...closePreviousTurn(messages),
			{ ...createAssistantMessage(), openedAtReadPoint: true },
		];
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

	// A subagent's own text and calls go under the call that spawned it, which
	// is not always in the bubble the turn is writing: a backgrounded subagent
	// keeps working while the conversation moves on, and a read point leaves a
	// foreground one in the bubble above. Filed, they touch no bubble's status —
	// they are the subagent's, and say nothing about the turn. A parent that is
	// not loaded leaves them to fall through and sit flat where they arrived.
	if (
		(event.type === "text" ||
			event.type === "tool_call" ||
			event.type === "thinking") &&
		event.parentToolUseId
	) {
		const filed = fileUnderParent(
			messages,
			event.parentToolUseId,
			{ ...event, parentToolUseId: undefined },
			options,
		);
		if (filed) return filed;
	}

	// A permission request names its call and no parent, so a subagent's is
	// found by the call itself, wherever it was filed. A main-conversation call
	// keeps the old rule below — its card goes into the turn's own bubble.
	if (event.type === "permission_request" && event.toolUseId) {
		const toolUseId = event.toolUseId;
		const filed = applyToNestedList(
			messages,
			(parts) => findToolRunPath(parts, toolUseId),
			event,
			options,
		);
		if (filed) return filed;
	}

	// A posted question names no call at all, and joins by position; a
	// subagent's is still found by its batch or its open `question_post`,
	// wherever that was filed.
	if (event.type === "question_posted") {
		const filed = applyToNestedList(
			messages,
			(parts) =>
				lastOfBatchPath(parts, event.askedAt) ?? openQuestionPostPath(parts),
			event,
			options,
		);
		if (filed) return filed;
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
	// that reply belongs to what the agent was already answering, not to what
	// the user just typed. So a bubble is opened by its first content event and
	// closed by a terminal event or by a read point — never by a user
	// message merely arriving underneath it (docs/lifecycle-ui.md §2.3). The
	// message closes it when the agent *reads* it, which is a record of its own
	// and may be seconds later.
	//
	// One turn has one ending, but not one bubble: `done` / `interrupted` /
	// `error` are still the only things that end a turn, and without one the
	// next turn would grow into this bubble. `messageReducer.test.ts` states
	// that dependency as a test, because it used to be covered by a second,
	// accidental rule — a user message closed the previous turn — that mid-turn
	// sending had to remove.
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
	// must still bring back the tail line.
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
		updated = [
			...messages,
			event.type === "permission_request"
				? { ...createAssistantMessage(), openedByCard: true }
				: createAssistantMessage(),
		];
		index = updated.length - 1;
	}

	const current = updated[index];
	if (current.role !== "assistant") {
		return updated; // Type guard - should never happen
	}

	// A discarded message is filed on the turn the Stop ended rather than drawn
	// where the record stands: the record says which turn, and the message it
	// names may be anywhere above — or, on the sender, not yet know its own id
	// (docs/discarded-messages-ui.md). It takes the generic path to find that
	// turn, so a page that opens on one still reaches the bubble below.
	const message: AssistantMessage =
		event.type === "message_discarded"
			? {
					...current,
					discardedMessageIds: [
						...(current.discardedMessageIds ?? []),
						event.messageId,
					],
				}
			: {
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
			message.authFailure = event.authFailure;
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
	const abortedTurn =
		message.status === "interrupted" ||
		message.status === "error" ||
		message.status === "process_ended";

	updated[index] = message;

	// Swept across every bubble, not only the one the ending landed in: a read
	// point closes a bubble where it stands, so a call that was in flight when
	// the agent picked up a mid-turn message is left running in a bubble the
	// turn has already moved past. Its result would have settled it, and an
	// aborted turn is exactly the case where no result is coming — so without
	// this the cut leaves a spinner above the ending that never stops.
	if (abortedTurn) {
		updated = settleRunningToolRuns(updated);
	}

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

/** Whether some of this run's children already sit flat, unfiled. */
function hasUnfiledChildren(
	messages: Message[],
	parentToolUseId: string,
): boolean {
	return messages.some(
		(msg) =>
			msg.role === "assistant" &&
			msg.parts.some(
				(part) =>
					"parentToolUseId" in part && part.parentToolUseId === parentToolUseId,
			),
	);
}

/**
 * Applies a subagent's event to the children of the run it names, and returns
 * null when that run is not loaded.
 *
 * Also null when some of the run's children loaded flat before it did: they
 * stay where they are, so what follows them goes flat too, after them, rather
 * than being filed above them and read out of order.
 */
function fileUnderParent(
	messages: Message[],
	parentToolUseId: string,
	event: NormalizedEvent,
	options: ApplyOptions,
): Message[] | null {
	// A subagent call the user approved has only its card until the engine
	// next reports on it, and the row is what its work is filed under. Live, a
	// progress line usually brings the row back first; replay has none, so the
	// work itself has to — or a reload would draw it flat.
	const rebuilt = updateRunById(messages, parentToolUseId, (run) => run, false);
	// A subagent's call can be asked about before it is announced (measured on
	// claude 2.1.286: the `permission_request` precedes the subagent's own
	// `tool_call`), and then the card had no row to find and went flat into the
	// turn's bubble. The call names its parent; the card goes with it.
	const stray =
		event.type === "tool_call" ? takeStrayCard(rebuilt, event.toolUseId) : null;
	const withRow = stray ? stray.messages : rebuilt;
	// Whether the turn has ended cut short, read as `applyEvent` reads it: the
	// parent may sit in a bubble a read point closed as complete before the
	// ending landed in the next one.
	const lastIndex = lastAssistantIndex(withRow);
	const turnCut =
		openAssistantIndex(withRow) < 0 &&
		lastIndex >= 0 &&
		isAbortedStatus(withRow[lastIndex]);
	for (let i = withRow.length - 1; i >= 0; i--) {
		const msg = withRow[i];
		if (msg.role !== "assistant") continue;
		const path = findToolRunPath(msg.parts, parentToolUseId);
		if (!path) continue;
		if (hasUnfiledChildren(withRow, parentToolUseId)) return null;
		const aborted = turnCut || isAbortedStatus(msg);
		const resumedLater = withRow
			.slice(i + 1)
			.some((later) => later.role === "user");
		// A subagent under a backgrounded one outlives its turn with it.
		const underBackground = path
			.slice(0, -1)
			.reduce<{ list: ContentPart[]; found: boolean }>(
				({ list, found }, index) => {
					const part = list[index];
					return part?.type === "tool_call"
						? {
								list: part.tool.children ?? [],
								found: found || part.tool.status === "background",
							}
						: { list: [], found };
				},
				{ list: msg.parts, found: false },
			).found;
		const parts = editAtPath(msg.parts, path, (list, index) => {
			const part = list[index];
			if (part.type !== "tool_call") return list; // Type guard - never happens
			const run = part.tool;
			const children = run.children ?? [];
			const applied = applyEventToParts(
				stray ? [...children, ...stray.parts] : children,
				event,
				options,
			);
			// A call trailing in after its subagent was cut short or failed has
			// nothing left to report on it — the same rule `settleToolRun` applies
			// to the calls that were already there. One that finished is another
			// matter: Claude resumes a finished subagent when the agent writes to
			// it (SendMessage), and the resumed work is filed under the call that
			// first spawned it, with its own results still to come — and so does one
			// that was cut short, once the user has sent a turn since.
			const cut =
				(run.status === "interrupted" || run.status === "error") &&
				!resumedLater;
			const filed: ContentPart = {
				...part,
				tool: {
					...run,
					children: cut ? settleRunningToolParts(applied) : applied,
				},
			};
			// Nor does work trailing a turn that was cut short while its subagent
			// was still running — the sweep `applyEvent` gives the turn's own late
			// content, kept to this subagent: it reaches a row the rebuild above
			// has only just put back, still running, and stops at one that had
			// finished, whose resumed work is still to report.
			const updatedList = [...list];
			updatedList[index] =
				aborted && !underBackground && run.status === "running"
					? settleRunningToolParts([filed])[0]
					: filed;
			return updatedList;
		});
		const updated = [...withRow];
		updated[i] = { ...msg, parts };
		return updated;
	}
	return null;
}

/**
 * The permission card for `toolUseId` that sits flat at the top of a bubble,
 * taken out of it with whatever of the call came with it, or null. Only the top: a card filed under some run was
 * already joined to its call. And only a card that names no parent: one that
 * does was left flat by a page boundary, and stays where it first loaded.
 *
 * A bubble the card alone made goes with it. Asked after its turn had ended — a
 * background subagent's — the card opened a bubble of its own, and left behind
 * empty it would read as a turn still running. Only that bubble while it is
 * open — one that answers a user message is the turn's, whether or not
 * anything is in it yet — and any bubble the card leaves empty once its turn
 * completed, which the ending would have dropped had it been empty then. Never
 * one whose turn was cut short: its ending is a line of its own.
 *
 * The row approval rebuilt beside the card goes along too, when the engine
 * reported on the call before announcing it: left behind, it would be the
 * call's second row.
 */
function takeStrayCard(
	messages: Message[],
	toolUseId: string,
): { messages: Message[]; parts: ContentPart[] } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const index = msg.parts.findIndex(
			(part) =>
				part.type === "permission_request" &&
				part.request.toolUseId === toolUseId &&
				!part.parentToolUseId,
		);
		if (index === -1) continue;
		const next = msg.parts[index + 1];
		const taken =
			next?.type === "tool_call" &&
			next.tool.id === toolUseId &&
			!next.parentToolUseId
				? 2
				: 1;
		const parts = msg.parts.filter((_, j) => j < index || j >= index + taken);
		const emptied =
			parts.length === 0 &&
			(msg.status === "complete" ||
				(msg.status === "streaming" && msg.openedByCard === true));
		const updated = emptied
			? messages.filter((_, j) => j !== i)
			: messages.map((m, j) => (j === i ? { ...msg, parts } : m));
		return {
			messages: updated,
			parts: msg.parts.slice(index, index + taken),
		};
	}
	return null;
}

/**
 * Applies an event to the list the part `locate` finds sits in, when that part
 * is a subagent's — some run's child. Null when nothing is found, or what is
 * found sits at the top of its bubble and the ordinary rule applies.
 */
function applyToNestedList(
	messages: Message[],
	locate: (parts: ContentPart[]) => PartPath | null,
	event: NormalizedEvent,
	options: ApplyOptions,
): Message[] | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const path = locate(msg.parts);
		if (!path) continue;
		if (path.length < 2) return null;
		const updated = [...messages];
		updated[i] = {
			...msg,
			parts: editChildrenAtPath(msg.parts, path.slice(0, -1), (children) =>
				applyEventToParts(children, event, options),
			),
		};
		return updated;
	}
	return null;
}

/**
 * `fn` over every part of every assistant bubble, at every depth. Hands back
 * the same list when nothing changed.
 */
function mapAllParts(
	messages: Message[],
	fn: (part: ContentPart) => ContentPart,
): Message[] {
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;
		const parts = mapPartsDeep(msg.parts, fn);
		if (parts === msg.parts) return msg;
		anyChanged = true;
		return { ...msg, parts };
	});
	return anyChanged ? updated : messages;
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
	return mapAllParts(messages, (part) =>
		part.type === "permission_request" &&
		part.status === "pending" &&
		!isLive(part.request.requestId)
			? { ...part, status: "expired" as const, reason }
			: part,
	);
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
	return mapAllParts(messages, (part) => {
		// A posted question is withdrawn, never expired: it belongs to the
		// session rather than to the process that asked it, so the only thing
		// that retires it is something naming it (docs/answering-ui.md §6). A
		// legacy card is settled the same way — its CLI withdrawing the
		// question is the one thing that can still name it.
		if (part.type === "question_record") {
			if (part.record.requestId !== requestId) return part;
			if (part.status !== "pending" && !isSupersededAnswer(part)) {
				return part;
			}
			const { answer: _, answerMessageId: __, ...rest } = part;
			return { ...rest, status: "cancelled" as const, reason };
		}
		if (part.type !== "permission_request") return part;
		if (part.request.requestId !== requestId) return part;

		if (part.status === "pending") {
			return { ...part, status: "expired" as const, reason };
		}
		if (part.status === "expired" && reason && part.reason === undefined) {
			return { ...part, reason };
		}
		return part;
	});
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
	return mapAllParts(messages, (part) => {
		const isTarget =
			part.type === "permission_request" &&
			part.request.requestId === requestId;
		if (!isTarget || part.status === status) return part;
		return { ...part, status };
	});
}

export function updatePermissionRequestStatus(
	messages: Message[],
	requestId: string,
	newStatus: "allowed" | "denied",
): Message[] {
	return mapAllParts(messages, (part) =>
		part.type === "permission_request" &&
		part.request.requestId === requestId &&
		part.status === "pending"
			? { ...part, status: newStatus }
			: part,
	);
}

/**
 * Settles the posted-question cards a message answered.
 *
 * The message record is the answer record — there is no second one per question
 * — so this is the only thing that ever moves a card from `pending` to
 * `answered` or `declined`. It guards on `pending`: a card something else has
 * already resolved keeps what resolved it, because that is what happened first
 * and nothing arriving later can know better.
 *
 * Except an earlier answer ({@link isSupersededAnswer}): a question answered
 * once is only ever answered again after a Stop threw the first answer away
 * unread, and the second one is then what the agent read.
 */
export function applyAnswering(
	messages: Message[],
	answering: QuestionAnswerRecord[],
	messageId?: string,
): Message[] {
	const byRequest = new Map(answering.map((a) => [a.request_id, a]));
	return mapAllParts(messages, (part) => {
		if (part.type !== "question_record") return part;
		if (part.status !== "pending" && !isSupersededAnswer(part, messageId)) {
			return part;
		}
		const answer = byRequest.get(part.record.requestId);
		if (!answer) return part;
		const status: QuestionRecordStatus = answer.declined
			? "declined"
			: "answered";
		const { answerMessageId: _, ...rest } = part;
		return {
			...rest,
			status,
			answer,
			...(messageId ? { answerMessageId: messageId } : {}),
		};
	});
}

/**
 * Whether a card's answer may be overtaken by a record naming its question
 * again: `by`, a later message answering it, or — absent — the question being
 * withdrawn.
 *
 * The server takes an answer, and withdraws a question, only while the
 * question is on the session's unanswered list, and an answered question is
 * only put back there when a Stop throws its answer away unread
 * (docs/code/agent-integration.md#a-discarded-answer-reopens-its-question). So
 * a later record naming it is itself the proof the first answer was never
 * read, and the reducer can follow history order without knowing which
 * messages were discarded — which it cannot, for the sender's own answer
 * (docs/code/frontend-state.md#discarded-messages).
 *
 * A legacy card is the CLI's own question and was never reopened.
 */
function isSupersededAnswer(
	part: Extract<ContentPart, { type: "question_record" }>,
	by?: string,
): boolean {
	return (
		!part.legacy &&
		(part.status === "answered" || part.status === "declined") &&
		part.answerMessageId !== undefined &&
		part.answerMessageId !== by
	);
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
			? applyAnswering(messages, event.answering, event.messageId)
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
		// A settled subagent leaves nothing spinning under it: a child still
		// running has lost the only process that could report on it. A
		// backgrounded child is left to its own notification.
		...(run.children ? { children: settleRunningToolParts(run.children) } : {}),
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

	// At any depth, both passes: a subagent's call is filed under its parent,
	// and its result names only itself.
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const path = findToolRunPath(msg.parts, toolUseId);
		if (!path) continue;

		let unchanged = false;
		const parts = editAtPath(msg.parts, path, (list, index) => {
			const part = list[index];
			if (part.type !== "tool_call") return list; // Type guard - never happens
			const run = update(part.tool);
			// Handing back the same run says the record changed nothing — progress
			// on a call that has already settled. The list is returned untouched,
			// so a transcript that did not change does not re-render.
			if (run === part.tool) {
				unchanged = true;
				return list;
			}
			const updatedList = [...list];
			updatedList[index] = { ...part, tool: run };
			return updatedList;
		});
		if (unchanged) return messages;
		const updated = [...messages];
		updated[i] = { ...msg, parts };
		return updated;
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const path = findPartPath(
			msg.parts,
			(part) =>
				part.type === "permission_request" &&
				part.request.toolUseId === toolUseId &&
				(fromPendingCard || part.status !== "pending"),
		);
		if (!path) continue;

		const parts = editAtPath(msg.parts, path, (list, cardIndex) => {
			const card = list[cardIndex];
			if (card.type !== "permission_request") return list; // Type guard - never happens
			const restored: ContentPart = {
				type: "tool_call",
				tool: update({
					id: toolUseId,
					name: card.request.toolName,
					input: card.request.toolInput,
					status: "running",
				}),
				...(card.parentToolUseId
					? { parentToolUseId: card.parentToolUseId }
					: {}),
			};
			const updatedList = [...list];
			updatedList.splice(cardIndex + 1, 0, restored);
			return updatedList;
		});
		const updated = [...messages];
		updated[i] = { ...msg, parts };
		return updated;
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
		const path = findToolRunPath(msg.parts, originToolUseId);
		if (!path) continue;

		let alreadyFiled = false;
		const parts = editAtPath(msg.parts, path, (list, index) => {
			const part = list[index];
			if (part.type !== "tool_call") return list; // Type guard - never happens
			const run = part.tool;
			// Already filed — the same call announced twice. Absorbed all the
			// same: what this returns is the absence of a row, not an entry.
			if (run.fetches?.some((fetch) => fetch.id === fetchToolUseId)) {
				alreadyFiled = true;
				return list;
			}
			const updatedList = [...list];
			updatedList[index] = {
				...part,
				tool: {
					...run,
					fetches: [...(run.fetches ?? []), { id: fetchToolUseId }],
				},
			};
			return updatedList;
		});
		if (alreadyFiled) return messages;
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
		const path = findPartPath(
			msg.parts,
			(part) =>
				part.type === "tool_call" &&
				!!part.tool.fetches?.some((fetch) => fetch.id === event.toolUseId),
		);
		if (!path) continue;

		const fetched: ToolFetch = {
			id: event.toolUseId,
			result: event.toolResult,
			...(event.contents ? { contents: event.contents } : {}),
			// The fetch failed, not the task it was reading: the run keeps its own
			// status, and only this entry says anything went wrong.
			...(event.isError ? { isError: true } : {}),
		};
		const parts = editAtPath(msg.parts, path, (list, index) => {
			const part = list[index];
			if (part.type !== "tool_call") return list; // Type guard - never happens
			const updatedList = [...list];
			updatedList[index] = {
				...part,
				tool: {
					...part.tool,
					fetches: part.tool.fetches?.map((fetch) =>
						fetch.id === event.toolUseId ? fetched : fetch,
					),
				},
			};
			return updatedList;
		});
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

function appendOutput(
	run: ToolRun,
	delta: string,
): Pick<ToolRun, "output" | "outputDroppedLines"> {
	const combined = (run.output ?? "") + delta;
	const lines = combined.split("\n");
	if (lines.length <= MAX_LIVE_OUTPUT_LINES) return { output: combined };
	return {
		output: lines.slice(-MAX_LIVE_OUTPUT_LINES).join("\n"),
		outputDroppedLines:
			(run.outputDroppedLines ?? 0) + lines.length - MAX_LIVE_OUTPUT_LINES,
	};
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
				...(event.outputDelta ? appendOutput(run, event.outputDelta) : {}),
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
 * definition, and its outcome is still coming. So is everything under it — a
 * backgrounded subagent's own calls are as alive as it is — while a subagent
 * that is settled here takes its running children with it.
 */
function settleRunningToolParts(parts: ContentPart[]): ContentPart[] {
	let changed = false;
	const updated = parts.map((part) => {
		if (part.type !== "tool_call" || part.tool.status === "background") {
			return part;
		}
		const children = part.tool.children
			? settleRunningToolParts(part.tool.children)
			: undefined;
		const settle = part.tool.status === "running";
		if (!settle && children === part.tool.children) return part;
		changed = true;
		return {
			...part,
			tool: {
				...part.tool,
				...(settle ? { status: "interrupted" as const } : {}),
				...(children ? { children } : {}),
			},
		};
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
	messageId?: string;
	source?: MessageOrigin;
	subtype?: string;
	meta?: SystemMessageMeta;
	anchorSeq?: HistorySeq;
	/** The posted questions this message answers; see QuestionAnswerRecord. */
	answering?: QuestionAnswerRecord[];
	command?: PockodeCommandInvocation;
	attachments?: FileBlock[];
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
		// What a Stop threw away is said at the end of the turn it ended.
		!message.discardedMessageIds &&
		message.status === "complete"
	);
}

// Declares that nothing is running any more: every bubble still open is settled
// as `complete`, and the ones the agent never wrote into are dropped rather than
// left as blank bubbles.
//
// Called where something other than a turn's own ending says the open bubble is
// finished: a message arriving at an idle agent (`appendUserMessage`), a page of
// history whose last turn ended in the page above it (`prependHistoryPage`), and
// the read point, which closes the bubble without the turn itself being over —
// the turn carries on writing, into the bubble opened underneath the message it
// has just read.
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
 *   placeholder is made, and `placeholder()` is not called: the agent has not
 *   read the message yet, and the bubble for what it writes afterwards is
 *   opened by the read point (`message_ingested` in `applyEvent`), which is the
 *   only thing that knows when "afterwards" starts. The bubble that is missing
 *   until then is what `useChatMessages` reads back as "sent, not picked up
 *   yet", so do not add one.
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
		...(options?.messageId ? { messageId: options.messageId } : {}),
		// Only tag the messages a person did not type; a plain user message stays
		// source-less. An agent's answer carries no subtype or meta — what there
		// is to say about it is on the answers themselves.
		...(options?.source === "system"
			? { source: options.source, subtype: options.subtype, meta: options.meta }
			: {}),
		...(options?.source === "agent" ? { source: options.source } : {}),
		...(options?.answering ? { answering: options.answering } : {}),
		...(options?.command ? { command: options.command } : {}),
		...(options?.attachments ? { attachments: options.attachments } : {}),
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
 * On top of the retirements above: a bubble still `streaming` once the turn is
 * no longer open has stopped, and it stopped the way the turn ended. An open
 * turn has not, whatever it is blocked on: an answered permission or a finished
 * background task resumes it in the same reply, and until then that reply's
 * turn-end slot stays empty (docs/turn-progress-ui.md §2.2) rather than offering
 * Copy and Fork on a reply that is not finished — which is also what the live
 * path shows, since neither blocker touches the transcript.
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
	if (turn.open) return retired;
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
	// Through the same rule the stream itself uses, so the messages either side
	// of the boundary come back as one part, a paragraph apart, as they would
	// have been had the page not been split there.
	const first = after[0];
	if (first?.type === "text") {
		return [
			...applyEventToParts(before, {
				type: "text",
				content: first.content,
				parentToolUseId: first.parentToolUseId,
			}),
			...after.slice(1),
		];
	}
	// The joined row keeps the newer half's id: that half was on screen first,
	// and a new key would remount it and close what the user had opened, as
	// `prependHistoryPage` keeps the bubble's own id for the same reason.
	const last = before.at(-1);
	if (
		first?.type === "thinking" &&
		last?.type === "thinking" &&
		last.parentToolUseId === first.parentToolUseId
	) {
		return [
			...before.slice(0, -1),
			{ ...first, thoughts: [...last.thoughts, ...first.thoughts] },
			...after.slice(1),
		];
	}
	return [...before, ...after];
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
 * reducer has two ways to produce a leading assistant message: that orphan case,
 * and a page that begins at a read point, whose first bubble is a cut the join
 * must not undo. The second says so on itself (`openedAtReadPoint`), which is
 * what keeps rejoining the first safe.
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
	// are in the page above. Left as it replayed, it would keep a tail line running
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

	// Not two halves of one bubble but two bubbles: the page above opens where
	// the agent picked up a message recorded in it, and what it wrote from there
	// answers that message rather than continuing the reply below. Joining them
	// would put the second message's answer back in the first's bubble — the
	// inversion this whole split exists to remove, reappearing once per page
	// boundary that happens to land on a read point.
	if (head.openedAtReadPoint) {
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
		// why the head is the one row the transcript never anchors on — it grows
		// from the inside (docs/agent-chat.md#reading-a-page-on-the-client).
		...head,
		...(endedAtBoundary
			? {
					status: tail.status,
					error: tail.error,
					authFailure: tail.authFailure,
				}
			: {}),
		parts: endedAtBoundary ? settleRunningToolParts(joined) : joined,
		createdAt: tail.createdAt,
		// The head's anchor wins when it has one: it names the later record, which
		// is where a fork of this message has to cut.
		...(head.anchorSeq === undefined && tail.anchorSeq !== undefined
			? { anchorSeq: tail.anchorSeq }
			: {}),
		...(tail.discardedMessageIds
			? {
					discardedMessageIds: [
						...tail.discardedMessageIds,
						...(head.discardedMessageIds ?? []),
					],
				}
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
