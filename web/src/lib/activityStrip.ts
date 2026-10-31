import type {
	AssistantMessage,
	ContentPart,
	Message,
	PermissionStatus,
	SessionTurn,
	TurnBlockerKind,
	UserMessage,
} from "../types/message";
import { openAssistantIndex } from "./messageReducer";
import { type LatestChild, subagentStepsLine } from "./subagentRun";
import { type LiveThinking, latestLine, thoughtLabel } from "./thinking";
import {
	isTaskTool,
	type ToolOutcome,
	toolSummary,
	toolSummaryLine,
} from "./toolSummary";

/**
 * What canvas view's activity strip says (docs/canvas-ui.md §11.1): what the
 * latest record of the reply says, and whether the agent is at it, which only
 * the turn says.
 */

/**
 * The reply the strip speaks for: the one being written — the tail line's
 * (`openAssistantIndex`) — and once none is, the last one. Not the last one
 * while the agent is at work with none open yet — the turn reported before
 * its first record, as a send from another device is — whose ending would be
 * read as this turn's.
 */
export function stripReplyIndex(
	messages: Message[],
	turn: SessionTurn,
): number {
	const open = openAssistantIndex(messages);
	if (open >= 0) return open;
	if (turn.phase === "running" || blockedOn(turn, "permission")) return -1;
	return messages.findLastIndex((m) => m.role === "assistant");
}

function blockedOn(turn: SessionTurn, kind: TurnBlockerKind): boolean {
	return (
		turn.phase === "blocked" &&
		(turn.blockers ?? []).some((b) => b.kind === kind)
	);
}

/**
 * The message a reply answers — a typed message or a canvas action — which
 * the turn's details draw above it. The nearest one before it: a message sent
 * mid-reply lands below the reply it went into.
 */
export function replyPrompt(
	messages: Message[],
	replyIndex: number,
): UserMessage | undefined {
	for (let i = replyIndex - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") return m;
	}
	return undefined;
}

export type ActivityItem =
	| { kind: "text"; text: string }
	| {
			kind: "call";
			name: string;
			input: unknown;
			/** Absent for a permission card, which asks about a call not run. */
			outcome?: ToolOutcome;
			/** A settled permission card's answer, said in words. */
			answer?: Exclude<PermissionStatus, "pending">;
			/** A subagent's latest child, as its row's second line has it. */
			child?: LatestChild;
	  }
	| { kind: "thinking"; latest: string }
	| { kind: "thought"; label: string }
	| { kind: "working" };

/**
 * The reply's latest item. Notices — system lines, warnings, command output,
 * a question record — are skipped: the strip says what the agent did, and chat
 * view holds the rest. `liveThinking` is the main agent thinking now, which no
 * record says yet.
 */
export function latestItem(
	parts: ContentPart[],
	liveThinking: LiveThinking | null,
): ActivityItem {
	if (liveThinking) {
		return {
			kind: "thinking",
			latest: latestLine(liveThinking.content || liveThinking.fullReasoning),
		};
	}
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		// A subagent's child sitting flat, its call not loaded: not what the
		// main agent did.
		if ("parentToolUseId" in part && part.parentToolUseId) continue;
		switch (part.type) {
			case "text": {
				const text = latestLine(part.content);
				if (text) return { kind: "text", text };
				break;
			}
			case "tool_call": {
				const { tool } = part;
				return {
					kind: "call",
					name: tool.name,
					input: tool.input,
					outcome: { status: tool.status, canvasRevision: tool.canvasRevision },
					child: isTaskTool(tool.name)
						? subagentStepsLine(tool)?.tail
						: undefined,
				};
			}
			case "thinking":
				return { kind: "thought", label: thoughtLabel(part.thoughts) };
			case "permission_request":
				return {
					kind: "call",
					name: part.request.toolName,
					input: part.request.toolInput,
					answer: part.status === "pending" ? undefined : part.status,
				};
		}
	}
	return { kind: "working" };
}

export const PERMISSION_ANSWER_WORDS: Record<
	Exclude<PermissionStatus, "pending">,
	string
> = { allowed: "Allowed", denied: "Denied", expired: "Expired" };

/** Said before the latest item once a reply has ended other than complete. */
export function endingPrefix(reply: AssistantMessage): string | undefined {
	switch (reply.status) {
		case "interrupted":
			return "Stopped";
		case "process_ended":
			return "The agent's process ended";
		default:
			return undefined;
	}
}

/**
 * Which of the strip's rows it is. Liveness is the turn's alone: the latest
 * record says what, never whether.
 *
 * - `unknown`: the session detail or the transcript has not arrived, and a
 *   placeholder turn must not be read as no turn yet.
 * - `optimistic`: a send just went out and the server has not reported the
 *   turn — this client's placeholder is up.
 */
export type StripPhase =
	| "unknown"
	| "not_started"
	| "optimistic"
	| "running"
	| "permission"
	| "background"
	| "idle";

export function stripPhase(
	turn: SessionTurn,
	reply: AssistantMessage | undefined,
	loaded: boolean,
): StripPhase {
	if (!loaded) return "unknown";
	if (turn.phase === "running") return "running";
	if (turn.phase === "blocked") {
		// Permission first, as the attention strip ranks them: it is the one
		// with something to press.
		return blockedOn(turn, "permission") ? "permission" : "background";
	}
	if (reply?.status === "sending") return "optimistic";
	return reply ? "idle" : "not_started";
}

/** The attention strip's wording, which the strip says in its place. */
export const BACKGROUND_WORDS = "Waiting on a background task";

/** What the strip's status region says when the phase changes. */
export const PHASE_ANNOUNCEMENT: Record<StripPhase, string> = {
	unknown: "",
	not_started: "",
	optimistic: "Agent working",
	running: "Agent working",
	permission: "Waiting for permission",
	background: BACKGROUND_WORDS,
	idle: "Agent finished",
};

/** What the strip's line holds, before it is drawn or said. */
export type StripLine =
	| { kind: "background" }
	| { kind: "error"; message: string }
	| { kind: "item"; prefix?: string; item: ActivityItem };

export function stripLine(
	phase: StripPhase,
	reply: AssistantMessage | undefined,
	liveThinking: LiveThinking | null,
): StripLine {
	if (phase === "background") return { kind: "background" };
	// An error is never left to chat view alone.
	if (reply?.status === "error") {
		return {
			kind: "error",
			message: reply.error || "The reply ended in an error.",
		};
	}
	return {
		kind: "item",
		prefix: reply && endingPrefix(reply),
		// Live thinking is the tail line's: only while the turn is producing.
		item: latestItem(
			reply?.parts ?? [],
			phase === "running" ? liveThinking : null,
		),
	};
}

/**
 * The line as one string, for the strip's accessible name: the drawn line is
 * spans side by side, whose text runs together when a name is computed.
 */
export function stripLineText(line: StripLine, workDir: string): string {
	if (line.kind === "background") return BACKGROUND_WORDS;
	if (line.kind === "error") return line.message;
	const words = [line.prefix, itemText(line.item, workDir)];
	return words.filter(Boolean).join(" · ");
}

function itemText(item: ActivityItem, workDir: string): string {
	switch (item.kind) {
		case "text":
			return item.text;
		case "thinking":
			return item.latest ? `Thinking… · ${item.latest}` : "Thinking…";
		case "thought":
			return item.label;
		case "working":
			return "Working";
		case "call": {
			const summary = toolSummary(item.name, item.input, workDir, item.outcome);
			const title = summary.chip
				? `${summary.title} ${summary.chip}`
				: summary.title;
			const what = item.child
				? `${title} · ${
						item.child.kind === "text"
							? item.child.text
							: toolSummaryLine(
									toolSummary(
										item.child.name,
										item.child.input,
										workDir,
										item.child.outcome,
									),
								)
					}`
				: [title, summary.detail + summary.detailTail]
						.filter(Boolean)
						.join(" ");
			return item.answer
				? `${what} · ${PERMISSION_ANSWER_WORDS[item.answer]}`
				: what;
		}
	}
}
