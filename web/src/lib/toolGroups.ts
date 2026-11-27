import type { ContentPart, Thought, ToolRun } from "../types/message";
import { splitNativePath } from "../utils/path";
import { oldestPart } from "./partTree";
import { stepId } from "./subagentRun";
import { thoughtLabel } from "./thinking";
import {
	isTaskTool,
	TOOL_VERBS,
	type ToolVerb,
	type ToolVerbReading,
	toolVerb,
} from "./toolSummary";

/**
 * A run of consecutive tool calls folded into one summary row
 * (docs/tool-call-ui.md#groups). Everything here is read off the parts as they
 * are now — whether a call failed, waits on the user or outlived its turn is
 * the reducer's live answer, never something recorded when the group formed —
 * so a group re-derives from scratch on every render and cannot go stale.
 */

/** How many settled calls it takes before a run is worth a summary. */
const MIN_FOLDABLE = 2;

/** Past for what a call did, present for what it is doing. */
export type SummaryTense = "past" | "present";

/** One thing a segment names, and how many of its calls it stands for. */
export interface SummaryName {
	text: string;
	/** More than 1 only for a call-counted verb: a re-run is worth counting. */
	times: number;
}

/**
 * What one verb did, or is doing, across the folded calls. Every call is in
 * `count`; `names` holds those that could be named, in the order they first
 * appeared, so a live group only ever appends.
 */
export interface SummarySegment {
	verb: ToolVerb;
	tense: SummaryTense;
	names: SummaryName[];
	/** Files for the file verbs, calls for the rest, as the line counts them. */
	count: number;
}

/**
 * What a group's summary row speaks for: exactly its folded members, never a
 * pinned one, which is in sight and speaks for itself. The rows a folded call
 * leaves when the group opens are therefore the very set counted here.
 */
export interface GroupSummary {
	/**
	 * The step the group is on: its newest running call that folds. Absent once
	 * none is running — and while a card in the group waits on the user, since
	 * then the machine is waiting for them, not busy.
	 */
	current?: ToolRun;
	/**
	 * The present segments first, in consequence order — live work is what the
	 * reader watches, and the front is the end a narrow line keeps longest —
	 * then the past ones. Empty when every folded call was cut short.
	 */
	segments: SummarySegment[];
	/** How long the folded thinking took, `Thought for 5s`. */
	thought?: string;
	/** How many folded calls were cut short. */
	interrupted: number;
}

export type RowEntry<T> =
	| { kind: "summary"; key: string; summary: GroupSummary }
	| {
			kind: "item";
			item: T;
			/**
			 * The call this part belongs to; a card and its row share one. A
			 * thinking, which is no call, has one of its own.
			 */
			call: string;
			/**
			 * The group this part folds into, absent for a part that never folds:
			 * one outside any group, or one pinned under its group's summary.
			 */
			group?: string;
	  };

/**
 * Parts that end a group and stand as rows of their own. A subagent call's row
 * is already a summary — its Process is the folded list — and its waiting
 * card sits under its row, which must stay visible. A plan is written for the
 * user to read, so it is prose in all but shape.
 */
function breaksGroups(part: ContentPart): boolean {
	const name =
		part.type === "tool_call"
			? part.tool.name
			: part.type === "permission_request"
				? part.request.toolName
				: undefined;
	return name !== undefined && (isTaskTool(name) || name === "ExitPlanMode");
}

interface Member<T> {
	call: string;
	row?: ToolRun;
	card?: Extract<ContentPart, { type: "permission_request" }>;
	items: T[];
}

type Fold = "settled" | "running" | "pinned";

/**
 * Where a call stands in its group. Only what cannot be undone folds a row the
 * reader already has in sight: a call that has settled stays settled, while a
 * running one may yet turn into a card, a failure or background work and would
 * pop back out of the summary, dissolving a group it had just formed
 * (docs/tool-call-ui.md#groups).
 *
 * - `settled` — finished, and the only kind that decides whether a group
 *   exists.
 * - `running` — a call that never had a card. It joins whatever group its
 *   settled neighbours form, as the step the group is on, and lies flat while
 *   they form none. Usually it arrives after the group did and so was never
 *   in sight; one already on screen folds only when other calls settle into a
 *   group around it. Either way, if it then turns pinned the group stands on
 *   its settled calls: the call comes into sight under the summary and
 *   nothing else moves.
 * - `pinned` — stays in sight. A failure is the one row the reader has to
 *   notice. Background work is pinned for good, finished or not: it settles
 *   long after the reader moved on, and moving it into the summary then would
 *   delete a row above them. A card is pinned until it is answered *and* its
 *   call has settled — until the row is back the card is all there is of the
 *   call, and once it is, the reader who approved the command watches it run
 *   to the end.
 */
function foldOf({ row, card }: Member<unknown>): Fold {
	if (!row || (card && card.status !== "allowed")) return "pinned";
	// Background work the process took with it was pinned as background up to
	// that moment, and the interrupt that settles it lands long after the
	// reader moved on — the same row above them that folding would delete.
	if (row.lostWithProcess) return "pinned";
	// Ahead of `fromBackground`: the reducer keeps an interrupt over any result
	// that turns up later, background ones included, so a call cut short is
	// settled before it can be marked and must not come back out of its group.
	if (row.status === "interrupted") return "settled";
	if (row.fromBackground) return "pinned";
	switch (row.status) {
		case "success":
			return "settled";
		case "running":
			return card ? "pinned" : "running";
		default:
			return "pinned";
	}
}

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many.replace("N", String(count));
}

interface Wording {
	/** The words before the names: `Edited`. Absent for a verb never named. */
	names?: string;
	/** The whole segment when it names nothing: `Edited 2 files`. */
	count: (count: number) => string;
}

const WORDING: Record<SummaryTense, Record<ToolVerb, Wording>> = {
	past: {
		edit: {
			names: "Edited",
			count: (n) => plural(n, "Edited 1 file", "Edited N files"),
		},
		run: {
			names: "Ran",
			count: (n) => plural(n, "Ran 1 command", "Ran N commands"),
		},
		read: {
			names: "Read",
			count: (n) => plural(n, "Read 1 file", "Read N files"),
		},
		search: {
			names: "Searched",
			count: (n) => plural(n, "Searched once", "Searched N times"),
		},
		fetch: {
			names: "Fetched",
			count: (n) => plural(n, "Fetched 1 page", "Fetched N pages"),
		},
		todo: { count: () => "Updated todos" },
		other: {
			names: "Used",
			count: (n) => plural(n, "Used 1 tool", "Used N tools"),
		},
	},
	present: {
		edit: {
			names: "Editing",
			count: (n) => plural(n, "Editing 1 file", "Editing N files"),
		},
		run: {
			names: "Running",
			count: (n) => plural(n, "Running 1 command", "Running N commands"),
		},
		read: {
			names: "Reading",
			count: (n) => plural(n, "Reading 1 file", "Reading N files"),
		},
		search: {
			names: "Searching",
			count: (n) => plural(n, "Searching", "Searching N times"),
		},
		fetch: {
			names: "Fetching",
			count: (n) => plural(n, "Fetching 1 page", "Fetching N pages"),
		},
		todo: { count: () => "Updating todos" },
		other: {
			names: "Using",
			count: (n) => plural(n, "Using 1 tool", "Using N tools"),
		},
	},
};

/**
 * Files by their base name, except where two in one segment share it: those
 * are named by the shortest ending of their paths that tells them apart, in
 * the separator the path itself uses.
 */
function fileNames(paths: string[]): string[] {
	const parts = paths.map(splitNativePath);
	const suffix = (segments: string[], length: number) =>
		segments.slice(-length).join("/");
	return parts.map((segments, index) => {
		const separator =
			/\\/.test(paths[index]) && !/\//.test(paths[index]) ? "\\" : "/";
		const others = parts.filter(
			(other, at) => at !== index && other.at(-1) === segments.at(-1),
		);
		let length = 1;
		while (
			length < segments.length &&
			others.some((other) => suffix(other, length) === suffix(segments, length))
		) {
			length++;
		}
		return segments.slice(-length).join(separator) || paths[index];
	});
}

/**
 * One verb's calls in one tense as a segment. Files are counted once however
 * often they were touched, so they never repeat; everything else counts calls,
 * and a repeated name is a repeated event.
 */
function segmentOf(
	verb: ToolVerb,
	tense: SummaryTense,
	readings: ToolVerbReading[],
): SummarySegment {
	// Keyed by the path with its separators made one, so `C:\a\b.ts` and
	// `C:/a/b.ts` are one file; the first spelling seen is the one named.
	const files = new Map<string, string>();
	const calls = new Map<string, number>();
	let unnamed = 0;
	for (const { paths, name } of readings) {
		if (paths) {
			for (const path of paths) {
				const key = path.replace(/[/\\]+/g, "/");
				if (!files.has(key)) files.set(key, path);
			}
		} else if (name !== undefined) calls.set(name, (calls.get(name) ?? 0) + 1);
		else unnamed++;
	}
	const names: SummaryName[] = [
		...fileNames([...files.values()]).map((text) => ({ text, times: 1 })),
		...[...calls].map(([text, times]) => ({ text, times })),
	];
	const count = names.reduce((sum, name) => sum + name.times, unnamed);
	return { verb, tense, names, count };
}

function summarize<T>(
	members: Member<T>[],
	folding: Member<T>[],
	thoughts: Thought[],
): GroupSummary {
	const readings = new Map<string, ToolVerbReading[]>();
	let interrupted = 0;
	let current: ToolRun | undefined;
	for (const { row } of folding) {
		if (!row) continue;
		if (row.status === "interrupted") interrupted++;
		// Only what succeeded or is under way: a failed Edit changed nothing,
		// and it is pinned in sight anyway.
		const tense =
			row.status === "success"
				? "past"
				: row.status === "running"
					? "present"
					: undefined;
		if (!tense) continue;
		if (tense === "present") current = row;
		const reading = toolVerb(row.name, row.input);
		const key = `${tense}:${reading.verb}`;
		readings.set(key, [...(readings.get(key) ?? []), reading]);
	}
	const waiting = members.some((member) => member.card?.status === "pending");
	const segments = (["present", "past"] as const).flatMap((tense) =>
		TOOL_VERBS.flatMap((verb) => {
			const found = readings.get(`${tense}:${verb}`);
			return found ? [segmentOf(verb, tense, found)] : [];
		}),
	);
	return {
		current: waiting ? undefined : current,
		segments,
		thought: thoughts.length > 0 ? thoughtLabel(thoughts) : undefined,
		interrupted,
	};
}

/**
 * One segment of a summary line as it is drawn: `lead` alone (`Read 3
 * files`), or the verb word, its names and how many calls went unnamed
 * (`Read a.ts, b.ts +1`).
 */
export interface FormSegment {
	lead: string;
	names: SummaryName[];
	/** What the segment covers beyond its names; names shown + this = count. */
	more: number;
}

/** How many names a segment carries at most, in the richest form. */
const MAX_NAMES = 3;

function formSegment(
	{ verb, tense, names, count }: SummarySegment,
	shown: number,
): FormSegment {
	const wording = WORDING[tense][verb];
	const kept = wording.names ? names.slice(0, shown) : [];
	if (kept.length === 0)
		return { lead: wording.count(count), names: [], more: 0 };
	const named = kept.reduce((sum, name) => sum + name.times, 0);
	return { lead: wording.names ?? "", names: kept, more: count - named };
}

/**
 * Every way the summary line can be drawn, richest first: names are given up
 * one at a time from the end of the line toward the start, so the most
 * consequential segments keep theirs longest, until only counts are left. The
 * row draws the first that fits — a cut name mid-list would make the count
 * lie, and CSS can only cut. Not strictly narrower each step (`Ran ls +1` is
 * shorter than `Ran 2 commands`), which is why the row takes the first fit
 * rather than searching by width.
 */
export function summaryForms(summary: GroupSummary): FormSegment[][] {
	const shown = summary.segments.map((segment) =>
		Math.min(MAX_NAMES, segment.names.length),
	);
	const tail: FormSegment[] = [];
	if (summary.thought) tail.push({ lead: summary.thought, names: [], more: 0 });
	if (summary.interrupted > 0) {
		tail.push({
			lead: `${summary.interrupted} interrupted`,
			names: [],
			more: 0,
		});
	}
	const form = () => [
		...summary.segments.map((segment, index) =>
			formSegment(segment, shown[index]),
		),
		...tail,
	];
	const forms = [form()];
	for (let index = shown.length - 1; index >= 0; index--) {
		while (shown[index] > 0) {
			shown[index]--;
			forms.push(form());
		}
	}
	return forms;
}

/** Cuts a run of calls with no breaker in it into members, by call. */
function membersOf<T extends { part: ContentPart }>(items: T[]): Member<T>[] {
	const byCall = new Map<string, Member<T>>();
	for (const item of items) {
		const call = stepId(item.part) ?? "";
		let member = byCall.get(call);
		if (!member) {
			member = { call, items: [] };
			byCall.set(call, member);
		}
		member.items.push(item);
		if (item.part.type === "tool_call") member.row = item.part.tool;
		if (item.part.type === "permission_request") member.card = item.part;
	}
	return [...byCall.values()];
}

/**
 * A thinking folds with its group but is no call: it never breaks a run, and
 * never counts toward the minimum — codex reasons before nearly every call,
 * and counting that would fold a lone call into a summary that hides its own
 * title (docs/turn-progress-ui.md#12-where-it-goes-and-groups).
 */
function groupEntries<T extends { part: ContentPart }>(
	items: T[],
): RowEntry<T>[] {
	const members = membersOf(
		items.filter((item) => item.part.type !== "thinking"),
	);
	const callOf = new Map<T, string>();
	for (const member of members) {
		for (const item of member.items) callOf.set(item, member.call);
	}
	const thoughts: Thought[] = [];
	for (const item of items) {
		if (item.part.type !== "thinking") continue;
		callOf.set(item, `thinking:${item.part.id}`);
		thoughts.push(...item.part.thoughts);
	}
	const fold = new Map(members.map((member) => [member, foldOf(member)]));
	const settled = members.filter((member) => fold.get(member) === "settled");
	if (settled.length < MIN_FOLDABLE) {
		return items.map((item) => ({
			kind: "item",
			item,
			call: callOf.get(item) ?? "",
		}));
	}
	const folding = members.filter((member) => fold.get(member) !== "pinned");
	// Named after its oldest member, not its first, for the reason a list is
	// (`oldestPart`): which groups are open is remembered by this key.
	const oldest = oldestPart(members.flatMap((member) => member.items));
	const key = `group:${oldest.part.id}`;
	const foldingCalls = new Set(folding.map((member) => member.call));
	return [
		{ kind: "summary", key, summary: summarize(members, folding, thoughts) },
		...items.map((item): RowEntry<T> => {
			const call = callOf.get(item) ?? "";
			return foldingCalls.has(call) || item.part.type === "thinking"
				? { kind: "item", item, call, group: key }
				: { kind: "item", item, call };
		}),
	];
}

/**
 * One list's rows as the list draws them, in transcript order: every part
 * once, with a summary entry before each run of calls that folds. A part keeps
 * its place whether or not its group is folded — folding only hides it — so
 * nothing remounts when a group forms or opens.
 *
 * `items` are the rows of one list (`partBlocks`); a subagent's Process is
 * handed in the same way, so a group reads the same at every depth.
 */
export function rowEntries<T extends { part: ContentPart }>(
	items: T[],
): RowEntry<T>[] {
	const entries: RowEntry<T>[] = [];
	let run: T[] = [];
	const flush = () => {
		entries.push(...groupEntries(run));
		run = [];
	};
	for (const item of items) {
		if (!breaksGroups(item.part)) {
			run.push(item);
			continue;
		}
		flush();
		entries.push({ kind: "item", item, call: stepId(item.part) ?? "" });
	}
	flush();
	return entries;
}
