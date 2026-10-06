import type { Thought, TurnPhase } from "../types/message";
import { formatElapsed } from "./toolRun";

/**
 * How a thinking row words what it holds (docs/turn-progress-ui.md#1-the-thinking-row).
 * A row may hold several records, merged; every rule here is over all of them.
 */

export function hasText(thought: Thought): boolean {
	return Boolean(thought.content || thought.fullReasoning);
}

/**
 * Whether the record is drawn at all. An empty one with no duration is a bare
 * `Thought` with nothing behind it, so it is set aside before rows are merged
 * and neither breaks a run nor costs a sum its number.
 */
export function isDrawnThought(thought: Thought): boolean {
	return (
		hasText(thought) || thought.redacted || thought.durationMs !== undefined
	);
}

/**
 * The sum of the durations, only if every record has one: a sum over some of
 * them would understate the whole.
 */
export function thoughtsDurationMs(thoughts: Thought[]): number | undefined {
	let total = 0;
	for (const { durationMs } of thoughts) {
		if (durationMs === undefined) return undefined;
		total += durationMs;
	}
	return total;
}

/**
 * Rounded up, so a think that happened is never `0s`; and in the live
 * counter's whole seconds, not the finished tool row's tenths — it is read as
 * a pulse, not compared to the decimal.
 */
function wholeSecondsMs(ms: number): number {
	return Math.max(1, Math.ceil(ms / 1000)) * 1000;
}

/** `Thought for 12s`, or `Thought` when the time is not known. */
export function thoughtLabel(thoughts: Thought[]): string {
	const ms = thoughtsDurationMs(thoughts);
	return ms === undefined
		? "Thought"
		: `Thought for ${formatElapsed(wholeSecondsMs(ms))}`;
}

function unit(count: number, name: string): string {
	return `${count} ${name}${count === 1 ? "" : "s"}`;
}

/** The label as a sentence to be read aloud: `Thought for 1 minute 20 seconds`. */
export function spokenThoughtLabel(thoughts: Thought[]): string {
	const ms = thoughtsDurationMs(thoughts);
	if (ms === undefined) return "Thought";
	const seconds = wholeSecondsMs(ms) / 1000;
	if (seconds < 60) return `Thought for ${unit(seconds, "second")}`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `Thought for ${unit(minutes, "minute")} ${unit(seconds % 60, "second")}`;
	}
	return `Thought for ${unit(Math.floor(minutes / 60), "hour")} ${unit(minutes % 60, "minute")}`;
}

/**
 * What the main agent is thinking right now, as far as its `thinking_delta`s
 * have said (docs/turn-progress-ui.md#23-what-it-says). Client-side only: it
 * lasts seconds, ends with the thinking's record, and a reconnect loses it —
 * which costs the tail line one word until the next signal.
 */
export interface LiveThinking {
	content: string;
	fullReasoning: string;
	/**
	 * The first delta this client saw already carried text, so the start of the
	 * thinking was missed — a subscription made mid-thinking. Codex opens every
	 * reasoning item with an empty delta, so a beginning this client saw never
	 * starts with text.
	 */
	joinedLate: boolean;
	/** The user opened it; the row it settles into opens too. */
	expanded: boolean;
}

/**
 * What the tail line draws from (docs/turn-progress-ui.md#2-the-tail-line).
 */
export interface TurnTail {
	phase: TurnPhase;
	/**
	 * When the open turn began, on this device's clock: the server's reading
	 * subtracted from when it arrived. Absent without a reading.
	 */
	openedAt?: number;
	/** The main agent is thinking now; null when it is not, or not known to be. */
	thinking: LiveThinking | null;
	onToggleThinking: () => void;
}

/**
 * Folds more text onto what the main agent has thought so far: a delta, or a
 * run of them already folded together. `live` is null before the first.
 */
export function applyThinkingDelta(
	live: LiveThinking | null,
	delta: { content: string; fullReasoning: string },
): LiveThinking {
	if (!live) {
		return {
			content: delta.content,
			fullReasoning: delta.fullReasoning,
			joinedLate: Boolean(delta.content || delta.fullReasoning),
			expanded: false,
		};
	}
	return {
		...live,
		content: live.content + delta.content,
		fullReasoning: live.fullReasoning + delta.fullReasoning,
	};
}

// A line's leading block marker — heading, quote, list bullet or number.
const BLOCK_MARKER = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/;
// Emphasis only where it is a pair of delimiters around words, so the `_` in
// `snake_case` and the `*` in `a * b` — common in reasoning about code — stay.
// No lookbehind: Safari before 16.4 cannot parse it, and a regex it cannot
// parse fails the whole module.
const STRONG = /(\*\*|__)(\S(?:.*?\S)??)\1/g;
const EMPHASIS = /(^|[^\w*])([*_])(\S(?:.*?\S)??)\2(?![\w*])/g;
const CODE_SPAN = /`([^`]*)`/;

/** Code spans keep their text untouched; only the prose around them loses markers. */
function stripInline(line: string): string {
	return line
		.split(CODE_SPAN)
		.map((piece, index) =>
			index % 2 === 1
				? piece
				: piece.replace(STRONG, "$2").replace(EMPHASIS, "$1$3"),
		)
		.join("")
		.replaceAll("`", "");
}

/**
 * The last non-empty line of the text so far, Markdown markers stripped: a
 * codex summary part opens on a bold heading, which is usually exactly the line
 * worth showing. Empty when there is no text yet.
 */
export function latestLine(text: string): string {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = stripInline(lines[i].trim().replace(BLOCK_MARKER, "")).trim();
		if (line) return line;
	}
	return "";
}
