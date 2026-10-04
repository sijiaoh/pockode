import type { Thought } from "../types/message";
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
