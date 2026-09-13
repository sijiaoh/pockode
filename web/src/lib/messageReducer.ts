import type {
	AskUserQuestion,
	AssistantMessage,
	ContentPart,
	HistorySeq,
	Message,
	MessageOrigin,
	PermissionUpdate,
	QuestionStatus,
	ServerNotification,
	SystemMessageMeta,
	TaskRun,
	UserMessage,
} from "../types/message";
import { generateUUID } from "../utils/uuid";

// Legacy history recorded system messages with origin "work" before the
// concept was renamed to "system". Map the old value so old sessions still
// take the system path.
function normalizeOrigin(raw: unknown): MessageOrigin | undefined {
	if (raw === "system" || raw === "work") return "system";
	if (raw === "user") return "user";
	return undefined;
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
	  }
	| {
			type: "tool_result";
			toolUseId: string;
			toolResult: string;
			isError: boolean;
	  }
	| { type: "warning"; message: string; code: string }
	| { type: "error"; error: string }
	| { type: "done" }
	| { type: "interrupted" }
	| { type: "process_ended" }
	| { type: "system"; content: string }
	| {
			// User message or system-driven message (history replay or broadcast)
			type: "message";
			content: string;
			origin?: MessageOrigin;
			subtype?: string;
			meta?: SystemMessageMeta;
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
	  }
	| {
			type: "ask_user_question";
			requestId: string;
			toolUseId: string;
			questions: AskUserQuestion[];
	  }
	| {
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
 * unaddressed record by position (session.StampHistorySeq).
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
			};
		case "tool_result":
			return {
				type: "tool_result",
				toolUseId: record.tool_use_id as string,
				toolResult: (record.tool_result as string) ?? "",
				isError: record.is_error === true,
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
		case "system":
			return { type: "system", content: (record.content as string) ?? "" };
		case "message":
			return {
				type: "message",
				content: (record.content as string) ?? "",
				origin: normalizeOrigin(record.origin),
				subtype: record.subtype as string | undefined,
				meta: record.meta as SystemMessageMeta | undefined,
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
			};
		case "ask_user_question":
			return {
				type: "ask_user_question",
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
 * The subagent tool goes by two names: the CLI renamed `Task` to `Agent`
 * (2.1.x emits `Agent`), and stored history holds whichever name was current
 * when it was recorded. Both render as the same part.
 */
function isTaskTool(toolName: string): boolean {
	return toolName === "Task" || toolName === "Agent";
}

function parseTaskInput(input: unknown): Omit<TaskRun, "toolUseId" | "status"> {
	const obj =
		input && typeof input === "object"
			? (input as Record<string, unknown>)
			: {};
	const subagentType =
		typeof obj.subagent_type === "string" ? obj.subagent_type : undefined;
	const description =
		typeof obj.description === "string" && obj.description.length > 0
			? obj.description
			: (subagentType ?? "Task");
	return {
		description,
		subagentType,
		prompt: typeof obj.prompt === "string" ? obj.prompt : undefined,
	};
}

/**
 * Appends a Task part where the call landed, so each Task reads in the order
 * the turn spawned it.
 *
 * Claude Code resends a tool_call after permission approval, so the same
 * toolUseId can arrive twice: the second one refreshes the input it describes
 * and leaves the Task's own state alone.
 */
function applyTaskCall(
	parts: ContentPart[],
	toolUseId: string,
	toolInput: unknown,
): ContentPart[] {
	const input = parseTaskInput(toolInput);
	const isThisTask = (
		part: ContentPart,
	): part is Extract<ContentPart, { type: "task" }> =>
		part.type === "task" && part.task.toolUseId === toolUseId;

	if (!parts.some(isThisTask)) {
		return [
			...parts,
			{ type: "task", task: { toolUseId, status: "running", ...input } },
		];
	}
	return parts.map((part) =>
		isThisTask(part) ? { ...part, task: { ...part.task, ...input } } : part,
	);
}

export function applyEventToParts(
	parts: ContentPart[],
	event: NormalizedEvent,
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
			if (isTaskTool(event.toolName)) {
				return applyTaskCall(parts, event.toolUseId, event.toolInput);
			}
			return [
				...parts,
				{
					type: "tool_call",
					tool: {
						id: event.toolUseId,
						name: event.toolName,
						input: event.toolInput,
					},
				},
			];
		case "permission_request":
			return [
				...parts,
				{
					type: "permission_request",
					request: {
						requestId: event.requestId,
						toolName: event.toolName,
						toolInput: event.toolInput,
						toolUseId: event.toolUseId,
						permissionSuggestions: event.permissionSuggestions,
					},
					status: "pending",
				},
			];
		case "ask_user_question": {
			const questionPart: ContentPart = {
				type: "ask_user_question",
				request: {
					requestId: event.requestId,
					toolUseId: event.toolUseId,
					questions: event.questions,
				},
				status: "pending",
			};
			// Claude asks through a regular AskUserQuestion tool call: the CLI
			// emits tool_call for it immediately before the question, and a
			// tool_result echoing the answers after. All three describe one tool
			// use, and the question card already renders the whole interaction, so
			// take the tool_call's place rather than sit beside a card duplicating
			// it. The trailing tool_result then matches no tool_call and is
			// dropped as an orphan.
			const toolCallIndex = event.toolUseId
				? parts.findIndex(
						(part) =>
							part.type === "tool_call" && part.tool.id === event.toolUseId,
					)
				: -1;
			if (toolCallIndex === -1) return [...parts, questionPart];

			const updated = [...parts];
			updated[toolCallIndex] = questionPart;
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
 * position because a user message is never the last element (the turn it opens
 * leaves an empty assistant placeholder behind it) and because the agent may have
 * streamed several messages in while the call was in flight.
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
): Message[] {
	// User message or system-driven message (history replay or broadcast)
	if (event.type === "message") {
		// Stamped inside applyUserMessage rather than by stampAnchorSeq: the turn
		// this message opens leaves an empty assistant placeholder behind it, so
		// the last element is not the one holding the record.
		return applyUserMessage(messages, event.content, {
			source: event.origin,
			subtype: event.subtype,
			meta: event.meta,
			anchorSeq: seq,
		});
	}

	return stampAnchorSeq(messages, applyEvent(messages, event), seq);
}

function applyEvent(messages: Message[], event: NormalizedEvent): Message[] {
	// Permission response updates existing permission_request across all messages
	if (event.type === "permission_response") {
		const newStatus = event.choice === "deny" ? "denied" : "allowed";
		return updatePermissionRequestStatus(messages, event.requestId, newStatus);
	}

	// Request cancelled (CLI cancelled either permission or question request)
	if (event.type === "request_cancelled") {
		let updated = expirePermissionRequest(messages, event.requestId);
		if (updated !== messages) return updated;
		updated = updateQuestionStatus(messages, event.requestId, "expired", null);
		return updated;
	}

	// Question response updates existing ask_user_question across all messages
	if (event.type === "question_response") {
		const newStatus: QuestionStatus =
			event.answers === null ? "cancelled" : "answered";
		return updateQuestionStatus(
			messages,
			event.requestId,
			newStatus,
			event.answers,
		);
	}

	// Tool result updates existing tool_call across all messages (may arrive after interrupt)
	if (event.type === "tool_result") {
		return updateToolResult(
			messages,
			event.toolUseId,
			event.toolResult,
			event.isError,
		);
	}

	// Terminal events only make sense for active (sending/streaming) messages
	const isTerminalEvent =
		event.type === "interrupted" ||
		event.type === "process_ended" ||
		event.type === "done" ||
		event.type === "error";

	// Only append to the last message if it's an assistant message that's sending/streaming.
	// This prevents content from going into the wrong bubble when multiple messages are sent
	// before the first response arrives.
	const last = messages[messages.length - 1];
	const hasActiveAssistant =
		last?.role === "assistant" &&
		(last.status === "sending" || last.status === "streaming");

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
	const turnEnded =
		last?.role === "assistant" &&
		(last.status === "interrupted" ||
			last.status === "error" ||
			last.status === "process_ended");
	const isLateContent = !hasActiveAssistant && turnEnded && !isTerminalEvent;

	let updated: Message[];
	let index: number;
	if (hasActiveAssistant || isLateContent) {
		updated = [...messages];
		index = updated.length - 1;
	} else {
		if (isTerminalEvent) {
			// No active message to terminate — but still expire pending dialogs on process end
			if (event.type === "process_ended") {
				return settleAfterProcessGone(messages);
			}
			return messages;
		}
		// For content events, create new assistant message to hold orphan event.
		// Remove empty sending messages and complete any streaming messages.
		updated = messages
			.map((m): Message | null => {
				if (m.role === "assistant" && m.status === "sending") {
					return null; // Remove empty sending messages
				}
				if (m.role === "assistant" && m.status === "streaming") {
					return { ...m, status: "complete" };
				}
				return m;
			})
			.filter((m): m is Message => m !== null);
		updated = [...updated, createAssistantMessage()];
		index = updated.length - 1;
	}

	const current = updated[index];
	if (current.role !== "assistant") {
		return updated; // Type guard - should never happen
	}

	const message: AssistantMessage = {
		...current,
		parts: applyEventToParts(current.parts, event),
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

	// A turn that ended this way has no Task left running: not the one it was
	// cut off in the middle of, and not one whose call trails in afterwards
	// either. Keyed on the resulting status rather than on the event so that
	// late content lands under the same rule.
	//
	// `complete` is deliberately absent: a background Task outlives the turn
	// that started it and reports back later
	// (agent-integration.md#background-waits).
	if (
		message.status === "interrupted" ||
		message.status === "error" ||
		message.status === "process_ended"
	) {
		message.parts = settleRunningTaskParts(message.parts);
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

export function expirePendingDialogs(messages: Message[]): Message[] {
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;

		let changed = false;
		const updatedParts = msg.parts.map((part) => {
			if (part.type === "permission_request" && part.status === "pending") {
				changed = true;
				return { ...part, status: "expired" as const };
			}
			if (part.type === "ask_user_question" && part.status === "pending") {
				changed = true;
				return { ...part, status: "expired" as const };
			}
			return part;
		});

		if (!changed) return msg;
		anyChanged = true;
		return { ...msg, parts: updatedParts };
	});
	return anyChanged ? updated : messages;
}

function expirePermissionRequest(
	messages: Message[],
	requestId: string,
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
				return { ...part, status: "expired" as const };
			}
			return part;
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

export function updateQuestionStatus(
	messages: Message[],
	requestId: string,
	newStatus: QuestionStatus,
	answers: Record<string, string> | null,
): Message[] {
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;

		let changed = false;
		const updatedParts = msg.parts.map((part) => {
			if (
				part.type === "ask_user_question" &&
				part.request.requestId === requestId &&
				part.status === "pending"
			) {
				changed = true;
				return {
					...part,
					status: newStatus,
					answers: answers ?? undefined,
				};
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
 * Records a Task's outcome. An interrupted Task keeps that status even though
 * its result finally showed up: the interrupt is a fact the result cannot undo.
 * The content is still kept, flagged as having landed after the fact.
 */
function settleTaskRun(
	task: TaskRun,
	toolResult: string,
	isError: boolean,
): TaskRun {
	if (task.status === "interrupted") {
		return { ...task, result: toolResult, resultAfterInterrupt: true };
	}
	return { ...task, result: toolResult, status: isError ? "failed" : "done" };
}

function updateToolResult(
	messages: Message[],
	toolUseId: string,
	toolResult: string,
	isError: boolean,
): Message[] {
	// A tool_result almost always targets a tool_call in the most recent
	// assistant message, and tool IDs are unique — scan from the end and stop
	// at the first match instead of re-walking the whole transcript per result.
	// Scanning every message is also what lets a result arriving after an
	// interrupt land back in the turn that started it.
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;

		const partIndex = msg.parts.findIndex(
			(part) =>
				(part.type === "tool_call" && part.tool.id === toolUseId) ||
				(part.type === "task" && part.task.toolUseId === toolUseId),
		);
		if (partIndex === -1) continue;

		const part = msg.parts[partIndex];
		let settled: ContentPart;
		if (part.type === "tool_call") {
			settled = { ...part, tool: { ...part.tool, result: toolResult } };
		} else if (part.type === "task") {
			settled = {
				...part,
				task: settleTaskRun(part.task, toolResult, isError),
			};
		} else {
			continue; // Type guard - never happens
		}

		const updatedParts = [...msg.parts];
		updatedParts[partIndex] = settled;
		const updated = [...messages];
		updated[i] = { ...msg, parts: updatedParts };
		return updated;
	}

	// If no matching tool_call found, ignore the orphan result
	return messages;
}

/**
 * Marks Tasks still running as interrupted, for use when nothing can report
 * back on them any more (the turn was cut short, or the process is gone).
 * Leaving them running would spin a Spinner that never stops.
 */
function settleRunningTaskParts(parts: ContentPart[]): ContentPart[] {
	let changed = false;
	const updated = parts.map((part) => {
		if (part.type !== "task" || part.task.status !== "running") return part;
		changed = true;
		return { ...part, task: { ...part.task, status: "interrupted" as const } };
	});
	return changed ? updated : parts;
}

export function settleRunningTasks(messages: Message[]): Message[] {
	let anyChanged = false;
	const updated = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;
		const parts = settleRunningTaskParts(msg.parts);
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

// Closes out whatever the agent was mid-way through, so an incoming message
// starts a fresh turn instead of appending to the previous one. Every message
// leaves a placeholder behind for the reply it provokes; the ones the agent
// never wrote into are dropped here rather than left as blank bubbles.
export function closePreviousTurn(messages: Message[]): Message[] {
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

// Finalizes any streaming assistant before adding new user message
export function applyUserMessage(
	messages: Message[],
	content: string,
	options?: UserMessageOptions,
): Message[] {
	const finalized = closePreviousTurn(messages);

	const userMessage: UserMessage = {
		id: generateUUID(),
		role: "user",
		content,
		status: "complete",
		createdAt: new Date(),
		...(options?.anchorSeq !== undefined
			? { anchorSeq: options.anchorSeq }
			: {}),
		// Only tag system-driven messages; a plain user message stays source-less.
		...(options?.source === "system"
			? { source: options.source, subtype: options.subtype, meta: options.meta }
			: {}),
	};

	return [...finalized, userMessage, createAssistantMessage()];
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
 * process is gone. Needed wherever history does not say so itself: a process
 * killed by a restart writes no `process_ended` for replay to find.
 */
export function settleAfterProcessGone(messages: Message[]): Message[] {
	return settleRunningTasks(expirePendingDialogs(messages));
}

export function isBackReference(record: unknown): boolean {
	const type = (record as Record<string, unknown> | null)?.type;
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
	 * The session's process is gone without history saying so — a restart killed
	 * it, so no `process_ended` was ever recorded. Nothing can still report back
	 * on a dialog or a Task this page left open.
	 */
	processEnded?: boolean;
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
	// retires only the dialogs and Tasks this page left open, which is the part
	// of it that is true here.
	closed = closePreviousTurn(closed);
	for (const record of catchUp.backReferences ?? []) {
		closed = applyServerEvent(
			closed,
			normalizeEvent(record as Record<string, unknown>),
		);
	}
	if (catchUp.processEnded) {
		closed = settleAfterProcessGone(closed);
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
		// the user had expanded inside it — and the scroll anchor is pinned to it.
		...head,
		...(endedAtBoundary ? { status: tail.status, error: tail.error } : {}),
		parts: endedAtBoundary ? settleRunningTaskParts(joined) : joined,
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
