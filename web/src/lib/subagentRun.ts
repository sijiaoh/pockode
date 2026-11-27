import type { ContentPart, Message, ToolRun } from "../types/message";
import { findToolRunChain } from "./partTree";
import { toolRunText } from "./toolRun";
import { isTaskTool } from "./toolSummary";

/**
 * What a subagent row derives from its children: how far it has come and what
 * it is doing now (docs/tool-call-ui.md#a-subagents-own-work). The count is
 * read off the children wherever there are any, the way a row's title is read
 * off its input; the engine's own figures fill in only what the children
 * cannot say.
 */

/**
 * The call a child stands for, whatever it is drawn as at the moment: a row,
 * a permission card that took the row's place, or a question card that
 * replaced a `question_post`. Text is not a call.
 *
 * A question card has no `tool_use_id` to give — its join is by position — so
 * its batch stands in: one `question_post` call posts every question of one
 * batch under one `asked_at`.
 */
export function stepId(part: ContentPart): string | undefined {
	switch (part.type) {
		case "tool_call":
			return part.tool.id;
		case "permission_request":
			return part.request.toolUseId || `request:${part.request.requestId}`;
		case "question_record":
			return `question:${part.record.askedAt ?? part.record.requestId}`;
		default:
			return undefined;
	}
}

/**
 * How many calls the subagent made. Counted by id rather than by row, so the
 * count neither drops by one while a card stands in for a row, nor doubles once
 * the approved row comes back beside its card.
 */
export function countSteps(parts: ContentPart[]): number {
	const ids = new Set<string>();
	for (const part of parts) {
		const id = stepId(part);
		if (id) ids.add(id);
	}
	return ids.size;
}

/** The newest child, in the terms the second line words it. */
export type LatestChild =
	| { kind: "text"; text: string }
	| { kind: "call"; name: string; input: unknown };

const MARKDOWN_BLOCK_MARKER = /^(?:\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+))+/;
// Bold, strike-through and code spans, which a subagent's report opens with as
// often as not ("**Findings:** ..."): drawn as one plain line, the markers are
// noise. Not `__` or a single `*`, which are as likely an identifier's own.
const MARKDOWN_INLINE_MARKER = /\*\*|~~|`/g;
const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;

/** A text's first line with something on it, without its Markdown markers. */
export function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const stripped = line
			.replace(MARKDOWN_BLOCK_MARKER, "")
			.replace(MARKDOWN_LINK, "$1")
			.replace(MARKDOWN_INLINE_MARKER, "")
			.trim();
		if (stripped) return stripped;
	}
	return "";
}

// Where: the result Claude hands an agent back from a subagent that ran inside
// its call (measured on claude 2.1.286). A preamble addressed to the model, the
// report with every line indented by two spaces, then the agentId and usage
// lines the model needs to resume the subagent:
//
//   [Subagent hand-back] The text below is ... The report follows:
//     The function name is `retry2`.
//   agentId: a555947eded58a158 (use SendMessage with to: ...)
//   <usage>subagent_tokens: 14824 ...</usage>
//
// claude 2.1.330 drops the two lines after the report — the id and the figures
// travel on the record's `subagent` instead — and may open with harness notes
// above the frame (`<tools-used-before-summary>Bash, Read</…>`), so the frame
// is found at the start of any line, and what is above it is the harness's.
const HAND_BACK = /(?:^|\n)\[Subagent hand-back\][^\n]*The report follows:\n/;

/**
 * The subagent's own report out of what its call returned. The frame around it
 * is written for the model, not the reader; a result in any other shape is
 * returned as it is, so a CLI that rewords the frame costs the unwrapping and
 * never the report.
 */
export function subagentReport(result: string): string {
	const frame = HAND_BACK.exec(result);
	if (!frame) return result;
	const lines: string[] = [];
	for (const line of result.slice(frame.index + frame[0].length).split("\n")) {
		// The first line at column zero is the harness's again.
		if (line !== "" && !line.startsWith("  ")) break;
		lines.push(line.slice(2));
	}
	// A frame with nothing in it is a subagent that reported nothing, which is
	// what an empty report says.
	return lines.join("\n").trim();
}

/**
 * What the subagent is doing now: its newest child that has something to say.
 * A call reads as its own row would, so the caller words it through the same
 * summary; a card standing in for a call reads as that call.
 */
export function latestChild(parts: ContentPart[]): LatestChild | undefined {
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		switch (part.type) {
			case "text": {
				const text = firstLine(part.content);
				if (text) return { kind: "text", text };
				break;
			}
			case "tool_call":
				return { kind: "call", name: part.tool.name, input: part.tool.input };
			case "permission_request":
				return {
					kind: "call",
					name: part.request.toolName,
					input: part.request.toolInput,
				};
			case "question_record": {
				const question = part.record.question;
				const text = firstLine(question.header || question.question);
				if (text) return { kind: "text", text };
				break;
			}
		}
	}
	return undefined;
}

/**
 * The first line of the newest text, when it came after the newest step; a
 * step, or nothing said, is undefined. A question card is a step, not words.
 */
export function textAfterSteps(parts: ContentPart[]): string | undefined {
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		if (stepId(part)) return undefined;
		if (part.type !== "text") continue;
		const text = firstLine(part.content);
		if (text) return text;
	}
	return undefined;
}

/**
 * How a step reads in a step window: what its own row or card shows, in one
 * of the shapes a row's glyph takes, plus `waiting` for a step that stands
 * behind a card waiting on the user.
 */
export type StepMark =
	| "running"
	| "waiting"
	| "success"
	| "error"
	| "interrupted";

/** One line of a step window. */
export interface RecentStep {
	id: string;
	mark: StepMark;
	label:
		| { kind: "call"; name: string; input: unknown }
		| { kind: "question"; text: string };
	/** The step's run, when it is drawn as a row: what its time is read off. */
	run?: ToolRun;
}

function recentStep(id: string, part: ContentPart): RecentStep | undefined {
	switch (part.type) {
		case "tool_call": {
			const run = part.tool;
			const mark: StepMark =
				run.status === "running" || run.status === "background"
					? "running"
					: run.status;
			return {
				id,
				mark,
				label: { kind: "call", name: run.name, input: run.input },
				run,
			};
		}
		case "permission_request": {
			// Allowed and not yet back as a row: it is running. Expired is a
			// request nobody answered before its asker went away — cut short.
			const marks = {
				pending: "waiting",
				allowed: "running",
				denied: "error",
				expired: "interrupted",
			} as const;
			return {
				id,
				mark: marks[part.status],
				label: {
					kind: "call",
					name: part.request.toolName,
					input: part.request.toolInput,
				},
			};
		}
		case "question_record": {
			// Declined or withdrawn, the question got no answer: it was cut
			// short, which is not the subagent failing.
			const marks = {
				pending: "waiting",
				answered: "success",
				declined: "interrupted",
				cancelled: "interrupted",
			} as const;
			const question = part.record.question;
			return {
				id,
				mark: marks[part.status],
				label: {
					kind: "question",
					text: firstLine(question.header || question.question),
				},
			};
		}
		default:
			return undefined;
	}
}

/**
 * The newest `limit` steps, oldest first. Ordered by when each step first
 * arrived, and drawn by its newest form: a card and the row that comes back
 * for it are one step (`stepId`).
 */
export function recentSteps(parts: ContentPart[], limit: number): RecentStep[] {
	if (limit <= 0) return [];
	const newest = new Map<string, ContentPart>();
	for (const part of parts) {
		const id = stepId(part);
		if (id) newest.set(id, part);
	}
	const steps: RecentStep[] = [];
	for (const [id, part] of [...newest].slice(-limit)) {
		const step = recentStep(id, part);
		if (step) steps.push(step);
	}
	return steps;
}

/**
 * How many window lines each subagent row of one list gets, by its id: none
 * for a row that draws no window (docs/tool-call-ui.md#the-step-window).
 *
 * The size is set by how many subagent rows the list holds, whatever their
 * status, so that parallel siblings stay skimmable on a phone. A live row
 * draws its window; a settled one keeps its frozen window only while a
 * sibling that was already running when it settled still runs, so the list
 * folds once, with the last of them — and a sibling resumed or added later
 * regrows nobody's. Read off the runs alone, so a reload draws what the live
 * view did; a missing time means no frozen window.
 *
 * `runs` are the rows as drawn: a resumed subagent's on its resume.
 */
export function stepWindowLines(runs: ToolRun[]): ReadonlyMap<string, number> {
	const size = runs.length === 1 ? 3 : runs.length === 2 ? 2 : 1;
	const live = runs.filter(isLiveRun);
	const lines = new Map<string, number>();
	for (const run of runs) {
		const { endedAt } = run;
		const drawn =
			isLiveRun(run) ||
			(endedAt !== undefined &&
				live.some(
					(sibling) =>
						sibling.startedAt !== undefined && sibling.startedAt < endedAt,
				));
		lines.set(run.id, drawn ? size : 0);
	}
	return lines;
}

/**
 * A subagent row's second line when it has something of its own to say; null
 * when it has not, and the shared rungs (`toolSecondLine`) then stand,
 * unchanged.
 */
export interface SubagentLine {
	/** How many calls it made, by `subagentToolUses`; 0 is not drawn. */
	toolUses: number;
	/**
	 * The subagent's context when it finished, on a settled figures line only;
	 * absent there when the engine reported none.
	 */
	tokens?: number;
	/** What follows the count: the latest child, or a background outcome. */
	tail?: LatestChild;
	/** Whether it is still moving; see `ToolSecondLine.live`. */
	live: boolean;
}

/** Whether the subagent is still at work: in its call, or in the background. */
export function isLiveRun(run: ToolRun): boolean {
	return run.status === "running" || run.status === "background";
}

/**
 * How many calls the subagent made — one counter per run, chosen by its data
 * and never by its status, so the live figure is the settled one
 * (docs/tool-call-ui.md#what-is-measured-and-where-each-figure-comes-from):
 * its children wherever it has any, which is the count its Process heading
 * shows; the CLI's own count only on a run with none — live from its progress,
 * settled from its result.
 *
 * `unfiled` are the run's children that sit flat, out of its children
 * (docs/tool-call-ui.md#what-is-not-filed). They count, because a count that
 * shrank across a page boundary would understate the work.
 */
export function subagentToolUses(
	run: ToolRun,
	unfiled?: UnfiledChildren,
): number {
	const children = countSteps(run.children ?? []) + (unfiled?.steps ?? 0);
	if (children > 0) return children;
	const reported = isLiveRun(run)
		? run.subagentProgress?.toolUses
		: run.subagent?.toolUses;
	return reported ?? 0;
}

/**
 * What a live subagent is doing now: its newest child, or before the first
 * one what the CLI said it last called. Shared by the row's second line and
 * the agents line (docs/turn-progress-ui.md#43-the-agents-line), so the two
 * cannot word it differently. Nothing when neither has anything to say.
 */
export function subagentNow(
	run: ToolRun,
	unfiled?: UnfiledChildren,
): LatestChild | undefined {
	const latest = unfiled?.latest ?? latestChild(run.children ?? []);
	if (latest) return latest;
	const lastTool = run.subagentProgress?.lastToolName;
	return lastTool
		? { kind: "call", name: lastTool, input: undefined }
		: undefined;
}

/**
 * The run's line, by its status (docs/tool-call-ui.md#status-by-status). The
 * newest unfiled child is the newest child of all, so it is what the subagent
 * is doing now.
 */
export function subagentLine(
	run: ToolRun,
	unfiled?: UnfiledChildren,
	/**
	 * Whether the row draws its step window under this line. The window names
	 * the calls, so the line then names none: its tail is only words the
	 * subagent said after its newest step
	 * (docs/tool-call-ui.md#the-step-window).
	 */
	window = false,
): SubagentLine | null {
	const toolUses = subagentToolUses(run, unfiled);
	const latest = unfiled?.latest ?? latestChild(run.children ?? []);
	const words = (): LatestChild | undefined => {
		const text = textAfterSteps([
			...(run.children ?? []),
			...(unfiled?.parts ?? []),
		]);
		return text ? { kind: "text", text } : undefined;
	};

	if (window && (isLiveRun(run) || run.status === "interrupted")) {
		return { toolUses, tail: words(), live: isLiveRun(run) };
	}
	if (isLiveRun(run)) {
		// Its activity only after what it is doing now, being
		// `Running <description>` — the row's detail said again.
		const tail: LatestChild | undefined =
			subagentNow(run, unfiled) ??
			(run.activity ? { kind: "text", text: run.activity } : undefined);
		if (toolUses === 0 && !run.subagentProgress?.lastToolName) return null;
		return { toolUses, tail, live: true };
	}
	// No subagent body opens itself, so a failure's why goes here: the first
	// line of its report, or of a backgrounded run's outcome — ahead of the
	// shared rungs too, whose failure rung is the tail of the raw result in mono
	// (for a framed report, its usage line). One that returned nothing keeps
	// its figures.
	if (run.status === "error") {
		const text = toolRunText(run);
		const why = firstLine(run.fromBackground ? text : subagentReport(text));
		if (why) {
			return { toolUses, tail: { kind: "text", text: why }, live: false };
		}
	}
	const tokens = figuresTokens(run);
	// Only a run that settled with figures has a line without a count.
	if (toolUses === 0 && !tokens) return null;
	// Frozen where it was cut: where it was is the news, and a late result's
	// tokens are not.
	if (run.status === "interrupted") {
		return { toolUses, tail: latest, live: false };
	}
	return { toolUses, tokens, live: false };
}

/** Tokens for a figures line: settled, not cut short, and not zero. */
function figuresTokens(run: ToolRun): number | undefined {
	if (run.status === "interrupted") return undefined;
	const tokens = run.subagent?.totalTokens;
	return tokens ? tokens : undefined;
}

/**
 * What a subagent's call returned, split by what it is. A backgrounded call's
 * text is not its report: the subagent's own account never reached this
 * client, and what did arrive is the notification that said how it ended — its
 * outcome, drawn under a label of its own. Drawing that as the report would
 * assert the agent read something it never did.
 */
export function subagentLastWords(run: ToolRun): {
	report: string;
	outcome: string;
} {
	const text = toolRunText(run);
	return run.fromBackground
		? { report: "", outcome: text }
		: { report: subagentReport(text), outcome: "" };
}

/**
 * The children without their echo of `lastWords` — the report or the
 * background outcome the body already draws. The parts are returned as they
 * are when they do not end in it.
 *
 * A subagent's last message is that text, and when the CLI streamed it as a
 * child too it would be drawn twice. Compared rather than assumed, because the
 * stream does not always carry it (measured on claude 2.1.286): a subagent that
 * ran inside its call hands its last message back without streaming it, and a
 * resumed one (SendMessage) streams words that are not the report at all.
 *
 * The echo may be only the last paragraph of the last part: messages from one
 * speaker in a row are joined into one part, a blank line apart, and the
 * report is the last of them alone.
 */
export function withoutEchoedReport(
	parts: ContentPart[],
	lastWords: string,
): ContentPart[] {
	const last = parts.at(-1);
	const words = lastWords.trim();
	if (!words || last?.type !== "text") return parts;
	const squash = (text: string) => text.replace(/\s+/g, " ").trim();
	const target = squash(words);
	// Where each paragraph after the first starts, so the cut keeps the words
	// before it exactly as they were.
	const starts = [
		0,
		...Array.from(
			last.content.matchAll(/\n[^\S\n]*\n\s*/g),
			(m) => m.index + m[0].length,
		),
	];
	for (let i = starts.length - 1; i >= 0; i--) {
		const tail = squash(last.content.slice(starts[i]));
		if (tail.length > target.length) return parts;
		if (tail !== target) continue;
		if (i === 0) return parts.slice(0, -1);
		return [
			...parts.slice(0, -1),
			{ ...last, content: last.content.slice(0, starts[i]).trimEnd() },
		];
	}
	return parts;
}

/**
 * A pending permission card is never drawn inside a Process: the Process is
 * closed by default, and a card in it would leave a session waiting on someone
 * who cannot see why. The outermost subagent row draws it instead.
 */
export function isPendingCard(part: ContentPart): boolean {
	return part.type === "permission_request" && part.status === "pending";
}

/**
 * The children a subagent's Process draws: without the echo of what the body
 * already shows above it (`withoutEchoedReport`), and without a pending card,
 * which the row draws instead.
 */
export function processChildren(run: ToolRun): ContentPart[] {
	const { report, outcome } = subagentLastWords(run);
	return withoutEchoedReport(run.children ?? [], report || outcome).filter(
		(part) => !isPendingCard(part),
	);
}

/**
 * Whether the subagent has work to show as a transcript of its own: what
 * decides its ⤢, and so every other way into that transcript
 * (docs/subagent-transcript-ui.md#the-way-in). One with none is gone to by its
 * row instead.
 */
export function hasProcess(run: ToolRun, unfiled?: UnfiledChildren): boolean {
	return processChildren(run).length > 0 || (unfiled?.count ?? 0) > 0;
}

/** A run's children that sit flat rather than under the call they belong to. */
export interface UnfiledChildren {
	/** The parts themselves, in arrival order: newer than any filed child. */
	parts: ContentPart[];
	/** How many parts: text and calls alike. */
	count: number;
	/** How many of them are calls, by the same rule as `countSteps`. */
	steps: number;
	/** The newest of them that has something to say. */
	latest?: LatestChild;
}

const NO_UNFILED: ReadonlyMap<string, UnfiledChildren> = new Map();

/**
 * The unfiled children themselves, by the run's `tool_use_id`, in arrival
 * order — for a reader that draws them rather than counting them: a
 * subagent's transcript, which shows its work whole
 * (docs/subagent-transcript-ui.md#unfiled-children).
 */
export function unfiledParts(
	messages: Message[],
): ReadonlyMap<string, ContentPart[]> {
	const byParent = new Map<string, ContentPart[]>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.parts) {
			const parent =
				"parentToolUseId" in part ? part.parentToolUseId : undefined;
			if (!parent) continue;
			const parts = byParent.get(parent) ?? [];
			parts.push(part);
			byParent.set(parent, parts);
		}
	}
	return byParent;
}

/**
 * The subagents from the chat down to this one, by `tool_use_id`, outermost
 * first — the levels its transcript opens with, so that going up always goes
 * to the subagent it ran under
 * (docs/subagent-transcript-ui.md#back-at-each-depth). A chain whose outermost
 * call sits flat goes on up through the run that call belongs to; it stops at
 * a run whose call is not loaded.
 */
export function subagentPath(messages: Message[], toolUseId: string): string[] {
	let path: string[] = [];
	let target: string | undefined = toolUseId;
	while (target !== undefined && !path.includes(target)) {
		const found = locateRun(messages, target);
		if (!found) break;
		path = [...found.chain.map((run) => run.id), ...path];
		target = found.parent;
	}
	return path.length > 0 ? path : [toolUseId];
}

function locateRun(
	messages: Message[],
	toolUseId: string,
): { chain: ToolRun[]; parent?: string } | undefined {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const chain = findToolRunChain(message.parts, toolUseId);
		if (!chain) continue;
		const outermost = message.parts.find(
			(part) => part.type === "tool_call" && part.tool === chain[0],
		);
		const parent =
			outermost?.type === "tool_call" ? outermost.parentToolUseId : undefined;
		return { chain, parent };
	}
	return undefined;
}

/**
 * Every run's unfiled children, by the run's `tool_use_id`.
 *
 * They are only ever at the top of a bubble: a child goes flat when its call
 * is not loaded, or when earlier siblings already went flat, and either way
 * it lands where the stream is. A fetch never takes a row back from under the
 * reader, so they stay where they first loaded, and this is how the call's
 * row still knows about them.
 */
export function unfiledChildren(
	messages: Message[],
): ReadonlyMap<string, UnfiledChildren> {
	const byParent = unfiledParts(messages);
	if (byParent.size === 0) return NO_UNFILED;
	const result = new Map<string, UnfiledChildren>();
	for (const [parent, parts] of byParent) {
		result.set(parent, {
			parts,
			count: parts.length,
			steps: countSteps(parts),
			latest: latestChild(parts),
		});
	}
	return result;
}

// Where: the tool a Claude agent resumes a subagent with, naming it by the id
// the subagent's call reported (measured on claude 2.1.286 and 2.1.330: its
// input is `{to, summary, message}`). The call hands back a placeholder at
// once, and the resumed subagent's outcome arrives as its background result.
const RESUME_TOOL = "SendMessage";

// Where: the line claude 2.1.286 ends a subagent's hand-back with, and the one
// a backgrounded subagent's placeholder carries (see HAND_BACK). 2.1.330 puts
// the id on the record's `subagent` instead.
const AGENT_ID_LINE = /^agentId: (\S+)/m;

/** The id the CLI named a subagent call's subagent by, if it named one. */
function subagentAgentId(run: ToolRun): string | undefined {
	if (run.subagent?.agentId) return run.subagent.agentId;
	for (const text of [run.result, run.placeholderResult]) {
		const id = text ? AGENT_ID_LINE.exec(text)?.[1] : undefined;
		if (id) return id;
	}
	return undefined;
}

const NO_RESUMES: ReadonlyMap<string, ToolRun> = new Map();

/**
 * Every settled subagent run that is running again, by its `tool_use_id`, with
 * the call that resumed it.
 *
 * A Claude subagent resumes under a call of its own (`SendMessage`), not under
 * the call that spawned it: its work is still filed under that call, but what
 * says it is running, and when it stops, is the resuming call's own status. So
 * it is read from there, each time, rather than copied onto the subagent's run
 * — a copy would have to follow that call through every way a call can settle
 * (its outcome, a turn cut short, its process ending), and one it missed would
 * leave the row spinning for good. Codex, whose resumed subagent settles the
 * spawn's call again, says so on that call instead (`resumeToolRun`).
 *
 * A run still live is not resumed by a message written to it: it never
 * stopped.
 */
export function liveResumes(messages: Message[]): ReadonlyMap<string, ToolRun> {
	const runsByAgent = new Map<string, ToolRun>();
	const resumes: ToolRun[] = [];
	const visit = (parts: ContentPart[]) => {
		for (const part of parts) {
			if (part.type !== "tool_call") continue;
			const run = part.tool;
			if (run.name === RESUME_TOOL) {
				if (isLiveRun(run)) resumes.push(run);
			} else if (isTaskTool(run.name)) {
				const agentId = subagentAgentId(run);
				if (agentId) runsByAgent.set(agentId, run);
			}
			if (run.children) visit(run.children);
		}
	};
	for (const message of messages) {
		if (message.role === "assistant") visit(message.parts);
	}
	if (resumes.length === 0) return NO_RESUMES;

	const result = new Map<string, ToolRun>();
	for (const resume of resumes) {
		const to = (resume.input as { to?: unknown } | null)?.to;
		const target = typeof to === "string" ? runsByAgent.get(to) : undefined;
		if (target && !isLiveRun(target)) result.set(target.id, resume);
	}
	return result.size > 0 ? result : NO_RESUMES;
}

/**
 * A resumed subagent's run as its row draws it: running, on the resuming
 * call's clock and live progress, since that is the run going on now. What it
 * reported last is kept for its body, as it is for a Codex subagent resumed.
 */
export function resumedRun(run: ToolRun, resume: ToolRun): ToolRun {
	const {
		endedAt: _endedAt,
		durationMs: _durationMs,
		startedAt: _startedAt,
		seenAt: _seenAt,
		...rest
	} = run;
	return {
		...rest,
		status: "running",
		activity: resume.activity,
		subagentProgress: resume.subagentProgress,
		...(resume.startedAt !== undefined ? { startedAt: resume.startedAt } : {}),
		...(resume.seenAt ? { seenAt: resume.seenAt } : {}),
	};
}
