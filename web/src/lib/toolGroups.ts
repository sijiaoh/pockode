import type { ContentPart, Thought, ToolRun } from "../types/message";
import { stepId } from "./subagentRun";
import { thoughtLabel } from "./thinking";
import { isTaskTool, TOOL_VERBS, type ToolVerb, toolVerb } from "./toolSummary";

/**
 * A run of consecutive tool calls folded into one summary row
 * (docs/tool-call-ui.md#groups). Everything here is read off the parts as they
 * are now — whether a call failed, waits on the user or outlived its turn is
 * the reducer's live answer, never something recorded when the group formed —
 * so a group re-derives from scratch on every render and cannot go stale.
 */

/** How many settled calls it takes before a run is worth a summary. */
const MIN_FOLDABLE = 2;

export interface GroupSummary {
	/** Every call in the group, by id: the folded ones and the pinned ones. */
	steps: number;
	/**
	 * The step the group is on: its newest running call that folds. Absent once
	 * none is running — and while a card in the group waits on the user, since
	 * then the machine is waiting for them, not busy.
	 */
	current?: ToolRun;
	/**
	 * What the settled calls did, `Edited 2 files`, in consequence order, and
	 * then how long the folded thinking took. Never empty: a group forms only
	 * on settled calls.
	 */
	segments: string[];
	/** How many folded calls were cut short. */
	interrupted: number;
	/**
	 * How many folded calls are still running — counted while a card waits too,
	 * when `current` is gone, so a group still at work never reads as done.
	 */
	running: number;
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

const VERB_WORDING: Record<ToolVerb, (count: number) => string> = {
	edit: (n) => plural(n, "Edited 1 file", "Edited N files"),
	run: (n) => plural(n, "Ran 1 command", "Ran N commands"),
	read: (n) => plural(n, "Read 1 file", "Read N files"),
	search: (n) => plural(n, "Searched once", "Searched N times"),
	fetch: (n) => plural(n, "Fetched 1 page", "Fetched N pages"),
	todo: () => "Updated todos",
	other: (n) => plural(n, "Used 1 tool", "Used N tools"),
};

function summarize<T>(
	members: Member<T>[],
	folding: Member<T>[],
	thoughts: Thought[],
): GroupSummary {
	// Files are counted once however often they were touched; everything else
	// counts calls. A call naming no file stands for one of its own.
	const counted = new Map<ToolVerb, Set<string>>();
	let interrupted = 0;
	let running = 0;
	let current: ToolRun | undefined;
	for (const { row, call } of folding) {
		if (!row) continue;
		if (row.status === "running") {
			current = row;
			running++;
		}
		if (row.status === "interrupted") interrupted++;
		// Only what succeeded: a failed Edit changed nothing, and it is pinned
		// in sight anyway.
		if (row.status !== "success") continue;
		const { verb, paths } = toolVerb(row.name, row.input);
		const keys = counted.get(verb) ?? new Set<string>();
		for (const key of paths ?? [`call:${call}`]) keys.add(key);
		counted.set(verb, keys);
	}
	const waiting = members.some((member) => member.card?.status === "pending");
	const segments = TOOL_VERBS.flatMap((verb) => {
		const count = counted.get(verb)?.size;
		return count ? [VERB_WORDING[verb](count)] : [];
	});
	// Least consequential of all, so it is the end a narrow screen cuts.
	if (thoughts.length > 0) segments.push(thoughtLabel(thoughts));
	if (interrupted > 0) segments.push(`${interrupted} interrupted`);
	return {
		steps: members.length,
		current: waiting ? undefined : current,
		segments,
		interrupted,
		running,
	};
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
 * counts toward neither the minimum nor the steps — codex reasons before
 * nearly every call, and counting that would fold a lone call into a summary
 * that hides its own title (docs/turn-progress-ui.md#12-where-it-goes-and-groups).
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
	const key = `group:${members[0].call}`;
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
