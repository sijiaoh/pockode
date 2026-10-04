import type { ToolFetch, ToolRun } from "../types/message";
import { contentBlocksText } from "./contentBlocks";

/**
 * The result as prose, wherever the agent put it.
 *
 * Takes a fetch as readily as a run: a fetch carries the outcome of a call in
 * the same two fields, and the rule for which of them to read is one rule, not
 * one per caller.
 */
export function toolRunText(run: ToolRun | ToolFetch): string {
	if (run.contents) return contentBlocksText(run.contents);
	return run.result ?? "";
}

/** The last line of `text` that has something on it, or "". */
export function lastNonEmptyLine(text: string): string {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trimEnd();
		if (line.trim().length > 0) return line;
	}
	return "";
}

/** The end of a running call's output, which is what the body shows. */
export function lastOutputLines(output: string, count: number): string {
	const lines = output.split("\n");
	return lines.length <= count ? output : lines.slice(-count).join("\n");
}

/**
 * What a fetch brought back, for the renderers that draw it.
 *
 * `fetchedOutputs` keeps only the fetches that came back at all: an entry with
 * neither field never returned, because the turn was cut short, and there is
 * nothing to draw for it — which is a different sentence from a fetch that
 * returned and had nothing to say.
 */
export interface FetchedOutput {
	/** The `tool_use_id` of the call that fetched it, for a stable key. */
	id: string;
	text: string;
	/** The fetch failed. Says nothing about the task it was reading. */
	isError: boolean;
	/**
	 * The fetch answered and had nothing to say: an empty result, and no blocks
	 * either. Not the same as blocks that hold no prose — that one answered with
	 * something this body has no way to draw, and calling it "no output yet"
	 * would be the very mistake the two fields are kept apart to prevent.
	 */
	isEmpty: boolean;
}

export function fetchedOutputs(run: ToolRun): FetchedOutput[] {
	if (!run.fetches) return [];
	const arrived = run.fetches.filter(
		(fetch) => fetch.result !== undefined || fetch.contents !== undefined,
	);
	return arrived.map((fetch) => ({
		id: fetch.id,
		text: toolRunText(fetch),
		isError: fetch.isError === true,
		isEmpty: !fetch.contents && !fetch.result?.trim(),
	}));
}

/**
 * The task's own output, out of the envelope the fetch brought it in.
 *
 * A fetch does not answer with bare output. Claude's `TaskOutput` answers with
 * a small document — `retrieval_status`, `task_id`, `task_type`, `status`, and
 * then the task's output inside `output` (measured against claude 2.1.263) — so
 * the last line of the answer as a whole is the closing tag and says nothing at
 * all. The row's second line is supposed to be the task's latest word, so it
 * reads what the envelope carries rather than the envelope.
 *
 * Only the one-line summary unwraps. The body draws the answer as it arrived,
 * because that block is the record of what a later call read, and a record that
 * has been tidied up is no longer one.
 *
 * Matching a tag is not the string-mining this model refuses elsewhere — that
 * rule is about reading facts out of the CLI's English sentences. A shape this
 * does not recognise falls through to the whole text, which is what it read
 * before and is never worse than a lone tag.
 */
const FETCH_ENVELOPE = /<output>\n?([\s\S]*?)\n?<\/output>/;

function fetchedPayload(text: string): string {
	return FETCH_ENVELOPE.exec(text)?.[1] ?? text;
}

/**
 * The newest fetch that has something to show, as text, or "".
 *
 * A failed fetch does not count and neither does one whose envelope came back
 * carrying nothing: the row's second line is this *run's* latest word, and a
 * fetch that failed is news about the call that did the fetching.
 */
function latestFetchedText(run: ToolRun): string {
	const usable = fetchedOutputs(run)
		.filter((fetched) => !fetched.isError)
		.map((fetched) => fetchedPayload(fetched.text))
		.filter((text) => text.trim());
	return usable.length > 0 ? usable[usable.length - 1] : "";
}

/**
 * The text of a call the tool itself refused, out of the tag Claude wraps it
 * in, or null when the result is not such a refusal.
 *
 * Claude answers an input its tool will not act on — an `Edit` whose
 * `old_string` is not in the file, a `Read` of a file that does not exist —
 * with `<tool_use_error>…</tool_use_error>`. The tag is the CLI's envelope, not
 * anything the tool said, so nothing that draws the text shows it.
 */
const TOOL_USE_ERROR = /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/;

function toolUseErrorText(text: string): string | null {
	return TOOL_USE_ERROR.exec(text)?.[1].trim() ?? null;
}

/** A result as it is drawn and copied: a refusal without its envelope. */
export function shownResult(text: string): string {
	return toolUseErrorText(text) ?? text;
}

const FAILURE_WORD = /error|fail|panic|✗|×/i;
/**
 * Lines that name a failure without saying what it was: stack frames — Node's
 * `at …`, Python's `File "…", line N`, Go's bare `path.go:N +0x…` (whose file
 * may well be `panic.go`) — and the header of the table tsc closes a
 * many-file failure with (`Errors  Files`).
 */
const NOT_A_VERDICT = [
	/^at\s/,
	/^File ".*", line \d+/,
	/^\S+:\d+( \+0x[0-9a-f]+)?$/,
	/^Errors\s+Files$/,
];

/**
 * The line of a failed command's output that says why it failed: the last one
 * naming a failure, or the last non-empty line when none does.
 *
 * Still read from the end, because that is where a build states its verdict
 * (`make: *** [build] Error 1`, go test's `FAIL pkg`). But not simply the last
 * line: a test runner ends on its timing (`Duration 1.31s`) and Node ends on a
 * stack frame, and those are the two failures a phone sees most. A stack frame
 * is skipped even when it names a failure — `at failTest (…)` is where, not why.
 */
function failureLine(text: string): string {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (
			FAILURE_WORD.test(line) &&
			!NOT_A_VERDICT.some((pattern) => pattern.test(line))
		) {
			return line;
		}
	}
	return lastNonEmptyLine(text).trim();
}

/**
 * Claude's background notification, `Background command "<description>"
 * <conclusion>` (server/agent/claude/task_lifecycle_test.go), cut to its
 * conclusion. The description is already the row's first line — the command —
 * and on a phone it is long enough to push the conclusion off the end, which is
 * the one part the user is waiting for. Any other sentence is left as it is.
 */
const BACKGROUND_COMMAND = /^Background command ".*" (\S.*)$/;

function backgroundConclusion(outcome: string): string {
	const conclusion = BACKGROUND_COMMAND.exec(outcome)?.[1];
	if (!conclusion) return outcome;
	return conclusion[0].toUpperCase() + conclusion.slice(1);
}

/**
 * The run's latest word: one line under the title, or nothing.
 *
 * While the run is live that is what it reports doing. When a backgrounded run
 * settles the line hands over to the outcome, and a foreground failure hands it
 * over to the line of the output that says why. Either way it **stays** — the
 * row must not change height there, because a background row is by definition
 * not at the tail of the transcript, and `MessageList` only compensates for
 * growth at the tail or in a settling history page. A foreground run drops its
 * line, and that row is at the tail by construction.
 */
export interface ToolSecondLine {
	text: string;
	/** Literal machine output rather than prose, so it is drawn in mono. */
	mono: boolean;
	/**
	 * Whether the text is still moving. A live line is hidden from the
	 * accessible name: the row is a button, and a button whose name changes
	 * several times a second is re-announced at every focus.
	 */
	live: boolean;
}

export function toolSecondLine(run: ToolRun): ToolSecondLine | null {
	if (run.status === "running" || run.status === "background") {
		if (run.activity) return { text: run.activity, mono: false, live: true };
		// A fetch comes before the output it was fetched from: both are this
		// call's machine output, and the fetch is the later word on it. `live:
		// false` though this rung sits in the running branch — the flag is about
		// the text, and a fetched line does not move again until the next fetch.
		const fetched = lastNonEmptyLine(latestFetchedText(run));
		if (fetched) return { text: fetched, mono: true, live: false };
		const line = run.output ? lastNonEmptyLine(run.output) : "";
		return line ? { text: line, mono: true, live: true } : null;
	}
	// Before the failure rung, not after: a backgrounded failure's outcome is the
	// notification's own summary sentence, which says more than the tail of a log
	// the user never asked for.
	if (run.fromBackground) {
		const outcome = toolRunText(run)
			.split("\n")
			.find((line) => line.trim());
		return outcome
			? { text: backgroundConclusion(outcome.trim()), mono: false, live: false }
			: null;
	}
	// A failed row keeps a line, because nothing else on it says *how* it failed
	// — the border and the glyph only say that it did.
	if (run.status === "error") {
		const text = toolRunText(run);
		// A refusal is a sentence about the input, not program output, and it
		// opens with its reason; what follows is the input quoted back.
		const refusal = toolUseErrorText(text);
		if (refusal !== null) {
			const reason = refusal.split("\n").find((line) => line.trim());
			return reason ? { text: reason.trim(), mono: false, live: false } : null;
		}
		const line = failureLine(text);
		return line ? { text: line, mono: true, live: false } : null;
	}
	return null;
}

/**
 * How long a call has been going, for a counter that is watched rather than
 * read once: whole seconds below a minute, because a tenth that changes every
 * tick is motion nobody asked for. A measured duration keeps its precision —
 * that one is a figure, not a clock.
 */
export function formatElapsed(ms: number): string {
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	return formatDuration(ms);
}

/**
 * A duration in the fewest units that still say it: one below a minute, two
 * above. Sub-second calls are the caller's to drop — a `Read` that took 40ms
 * does not need a number.
 */
export function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;

	const totalMinutes = Math.floor(seconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${Math.floor(seconds % 60)}s`;
	return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/** A count of calls, as a subagent row and a folded group both word it. */
export function stepsLabel(steps: number): string {
	return steps === 1 ? "1 step" : `${steps} steps`;
}
