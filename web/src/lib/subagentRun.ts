import type { ContentPart, Message, ToolRun } from "../types/message";
import { toolRunText } from "./toolRun";

/**
 * What a subagent row derives from its children: how far it has come and what
 * it is doing now (docs/tool-call-ui.md#a-subagents-own-work). Nothing here is
 * sent — every figure is read off the children, the way a row's title is read
 * off its input.
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
function stepId(part: ContentPart): string | undefined {
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
const HAND_BACK = /^\[Subagent hand-back\][^\n]*The report follows:\n/;

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
	for (const line of result.slice(frame[0].length).split("\n")) {
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
 * A subagent row's second line when it has steps; null when it has none, and
 * the shared rungs (`toolSecondLine`) then stand, unchanged.
 */
export interface StepsLine {
	steps: number;
	/** What follows the count: the latest child, or a background outcome. */
	tail?: LatestChild;
	/** Whether it is still moving; see `ToolSecondLine.live`. */
	live: boolean;
}

/**
 * `unfiled` are the run's children that sit flat, out of its children
 * (docs/tool-call-ui.md#what-is-not-filed). They count, because a count that
 * shrank across a page boundary would understate the work; and they are the
 * newer ones, so the newest of them is what it is doing now.
 */
export function subagentStepsLine(
	run: ToolRun,
	unfiled?: UnfiledChildren,
): StepsLine | null {
	const children = run.children ?? [];
	const steps = countSteps(children) + (unfiled?.steps ?? 0);
	if (steps === 0) return null;
	const latest = unfiled?.latest ?? latestChild(children);

	if (run.status === "running" || run.status === "background") {
		return { steps, tail: latest, live: true };
	}
	// Frozen where it was cut: where it was is the news.
	if (run.status === "interrupted") {
		return { steps, tail: latest, live: false };
	}
	if (run.fromBackground) {
		const outcome = firstLine(toolRunText(run));
		return {
			steps,
			tail: outcome ? { kind: "text", text: outcome } : undefined,
			live: false,
		};
	}
	return { steps, live: false };
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

/** A run's children that sit flat rather than under the call they belong to. */
export interface UnfiledChildren {
	/** How many parts: text and calls alike. */
	count: number;
	/** How many of them are calls, by the same rule as `countSteps`. */
	steps: number;
	/** The newest of them that has something to say. */
	latest?: LatestChild;
}

const NO_UNFILED: ReadonlyMap<string, UnfiledChildren> = new Map();

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
	if (byParent.size === 0) return NO_UNFILED;
	const result = new Map<string, UnfiledChildren>();
	for (const [parent, parts] of byParent) {
		result.set(parent, {
			count: parts.length,
			steps: countSteps(parts),
			latest: latestChild(parts),
		});
	}
	return result;
}
