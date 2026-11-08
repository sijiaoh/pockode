/**
 * What the History segment draws, decided apart from React: how many lanes
 * fit, which ref chips a row shows, what a screen reader hears for it, and
 * which commits claim the reserved lanes. The geometry is
 * docs/git-history-ui.md's; the lane layout itself is `commitGraph.ts`'s.
 */

import type {
	GitBranchRange,
	GitCommit,
	GitHistoryScope,
	GitRef,
} from "../types/git";
import {
	createGraphState,
	type GraphCommit,
	type GraphRow,
	type GraphState,
	layoutCommits,
} from "./commitGraph";

/** Fixed, so lines meet edge to edge and the virtual list knows every height. */
export const ROW_HEIGHT = 52;
export const LANE_WIDTH = 14;
/** The `+N` slot lanes past the cap fold into. */
export const OVERFLOW_WIDTH = 18;
/** Left of the graph, and again between the graph and the text. */
export const ROW_GAP = 8;
/** The text column is never squeezed under this to fit more lanes. */
export const MIN_TEXT_WIDTH = 160;
/** Under this a row has room for one ref chip, not two. */
export const TWO_CHIP_TEXT_WIDTH = 240;
/** The row's `⋯`: `iconButtonClass`'s box, grown under a coarse pointer. */
export const MENU_WIDTH = { fine: 36, coarse: 44 } as const;

/** After the last keystroke (docs/git-history-ui.md#entering-them). */
export const HISTORY_SEARCH_DEBOUNCE_MS = 300;

/** The number of distinct line colours, `--th-graph-1` … `--th-graph-8`. */
export const GRAPH_COLORS = 8;

/** A line's colour as a CSS value; lines past the eighth cycle round. */
export function lineColor(line: number): string {
	return `var(--th-graph-${(line % GRAPH_COLORS) + 1})`;
}

/**
 * How many lanes are drawn before the rest fold into `+N`: the tier's (4 on a
 * phone, 8 at `expanded`) or what fits beside a text column of
 * `MIN_TEXT_WIDTH`, whichever is smaller, and never none.
 */
export function laneCap(
	listWidth: number,
	menuWidth: number,
	expanded: boolean,
): number {
	const tier = expanded ? 8 : 4;
	const byWidth = Math.floor(
		(listWidth - ROW_GAP * 2 - menuWidth - OVERFLOW_WIDTH - MIN_TEXT_WIDTH) /
			LANE_WIDTH,
	);
	return Math.max(1, Math.min(tier, byWidth));
}

/** How many lanes a row reaches into, empty reserved lanes included. */
export function lanesUsed(row: GraphRow): number {
	let max = row.lane;
	for (const edge of [...row.above, ...row.below]) {
		max = Math.max(max, edge.from, edge.to);
	}
	return max + 1;
}

/** The graph column's width for rows reaching into `lanes` lanes. */
export function graphWidth(lanes: number, cap: number): number {
	return lanes > cap
		? cap * LANE_WIDTH + OVERFLOW_WIDTH
		: Math.max(1, lanes) * LANE_WIDTH;
}

/** The query a history list is read with, as far as the graph cares. */
export interface GraphOptions {
	scope: GitHistoryScope | GitBranchRange["scope"];
	/** The first page's `default_line`: the refs lane 1 is kept for. */
	defaultLine: readonly string[] | undefined;
}

/**
 * Lane 0 is HEAD's line in every range; lane 1 the default branch's, where
 * the server says that branch is a line of its own — walked from and not in
 * HEAD's history. Elsewhere a lane kept for it would stay empty
 * (docs/git-history-ui.md#lane-order).
 */
export function createHistoryGraphState({
	scope,
	defaultLine,
}: GraphOptions): GraphState {
	if (scope === "mainline") {
		return createGraphState({ firstParent: true, reserve: 1 });
	}
	return createGraphState({ reserve: defaultLine?.length ? 2 : 1 });
}

/** The name a remote-tracking ref has on its remote: `origin/a/b` → `a/b`. */
function remoteBranchName(ref: string): string {
	return ref.slice(ref.indexOf("/") + 1);
}

function claimsOf(
	commit: GitCommit,
	defaultLine: readonly string[] | undefined,
): number[] {
	const claims: number[] = [];
	const refs = commit.refs ?? [];
	if (refs.some((r) => r.type === "head")) claims.push(0);
	if (
		defaultLine?.length &&
		refs.some(
			(r) =>
				(r.type === "branch" || r.type === "remote") &&
				defaultLine.includes(r.name),
		)
	) {
		claims.push(1);
	}
	return claims;
}

/** Lays out one page of commits, continuing from `state`. */
export function layoutHistoryPage(
	commits: readonly GitCommit[],
	state: GraphState,
	defaultLine: readonly string[] | undefined,
): { rows: GraphRow[]; state: GraphState } {
	const graphCommits: GraphCommit[] = commits.map((commit) => ({
		hash: commit.hash,
		parents: commit.parents,
		claims: claimsOf(commit, defaultLine),
	}));
	return layoutCommits(graphCommits, state);
}

/** One ref marker on a row. */
export interface RefChip {
	kind: "head" | "current" | "branch" | "remote" | "tag";
	name: string;
	/** A remote branch of the same name points here too, folded into this chip. */
	pushed?: boolean;
	/** Every ref name the chip stands for, for the `+N` hover and the screen reader. */
	names: string[];
}

/**
 * A commit's refs as chips: detached HEAD, the current branch, other local
 * branches, remote branches no local one of the same name stands beside, then
 * tags. `HEAD` folds into the current branch's chip, and a remote branch into
 * the local one of its name (docs/git-history-ui.md#ref-markers).
 */
export function refChips(refs: readonly GitRef[] | undefined): RefChip[] {
	if (!refs?.length) return [];
	const head = refs.find((r) => r.type === "head");
	const current = refs.find((r) => r.type === "branch" && r.current);
	const locals = refs.filter((r) => r.type === "branch");
	const localNames = new Set(locals.map((r) => r.name));
	const remotes = refs.filter((r) => r.type === "remote");
	const folded = new Set(
		remotes
			.filter((r) => localNames.has(remoteBranchName(r.name)))
			.map((r) => r.name),
	);
	const remotesOf = (local: string) =>
		remotes
			.filter((r) => remoteBranchName(r.name) === local)
			.map((r) => r.name);

	const chips: RefChip[] = [];
	if (head && !current) chips.push({ kind: "head", name: "HEAD", names: [] });
	const localChip = (ref: GitRef): RefChip => {
		const pushedAs = remotesOf(ref.name);
		return {
			kind: ref.current ? "current" : "branch",
			name: ref.name,
			...(pushedAs.length > 0 ? { pushed: true } : {}),
			names: [ref.name, ...pushedAs],
		};
	};
	if (current) chips.push(localChip(current));
	for (const ref of locals) {
		if (ref !== current) chips.push(localChip(ref));
	}
	for (const ref of remotes) {
		if (!folded.has(ref.name)) {
			chips.push({ kind: "remote", name: ref.name, names: [ref.name] });
		}
	}
	for (const ref of refs) {
		if (ref.type === "tag") {
			chips.push({ kind: "tag", name: ref.name, names: [ref.name] });
		}
	}
	return chips;
}

/** At most two chips, one where the text column is a phone's. */
export function chipLimit(textWidth: number): number {
	return textWidth < TWO_CHIP_TEXT_WIDTH ? 1 : 2;
}

/** `Branch a` / `Branches a, b`. */
function listed(one: string, many: string, names: string[]): string | null {
	if (names.length === 0) return null;
	return `${names.length === 1 ? one : many} ${names.join(", ")}.`;
}

/**
 * The row's name for a screen reader, which the graph is hidden from: every
 * sentence only where it applies.
 */
export function describeCommitRow(
	commit: GitCommit,
	options: { laneHidden?: boolean } = {},
): string {
	const refs = commit.refs ?? [];
	const detached =
		refs.some((r) => r.type === "head") &&
		!refs.some((r) => r.type === "branch" && r.current);
	const parts = [
		`Commit ${commit.hash.substring(0, 7)}: ${commit.subject}.`,
		commit.unpushed ? "Not pushed." : null,
		commit.parents.length > 1 ? "Merge commit." : null,
		detached ? "Detached HEAD." : null,
		listed(
			"Branch",
			"Branches",
			refs
				.filter((r) => r.type === "branch" || r.type === "remote")
				.map((r) => r.name),
		),
		listed(
			"Tag",
			"Tags",
			refs.filter((r) => r.type === "tag").map((r) => r.name),
		),
		options.laneHidden ? "On a line not drawn." : null,
	];
	return parts.filter(Boolean).join(" ");
}

/** The range picker's words (docs/git-history-ui.md#range). */
export function describeScope(
	scope: GitHistoryScope,
	defaultBranch: string | undefined,
): { label: string; description: string } {
	switch (scope) {
		case "current":
			return defaultBranch
				? {
						label: `Current + ${defaultBranch}`,
						description: `This branch, its upstream and ${defaultBranch}`,
					}
				: {
						label: "Current branch",
						description: "This branch and its upstream",
					};
		case "all":
			return {
				label: "All branches",
				description: "Every local branch and its upstream",
			};
		case "mainline":
			return {
				label: "Mainline only",
				description: "This branch's own line — a merge shows as one commit",
			};
	}
}

/** HEAD is told by its ref, never by a row's position. */
export function isHeadCommit(commit: Pick<GitCommit, "refs">): boolean {
	return commit.refs?.some((r) => r.type === "head") ?? false;
}

/**
 * Which listed commits HEAD reaches, in the list's order. In date order every
 * commit on a path from HEAD comes before the commits it leads to, and HEAD is
 * a tip of every range, so the listed commits alone decide it: one pass,
 * carrying the parents still wanted (docs/git-history-ui.md#the-commit-menu).
 *
 * Only over a connected history — a search or a file filter has no such path.
 */
export function headHistoryFlags(
	commits: readonly Pick<GitCommit, "hash" | "parents" | "refs">[],
): boolean[] {
	const wanted = new Set<string>();
	return commits.map((commit) => {
		const reached = isHeadCommit(commit) || wanted.delete(commit.hash);
		if (reached) for (const parent of commit.parents) wanted.add(parent);
		return reached;
	});
}

/**
 * What `Ask AI to revert` puts in the composer, built at the press from the
 * branch HEAD is on then — null while detached, undefined while
 * `git.branches` has not answered (docs/git-history-ui.md#ask-ai-to-revert).
 */
export function describeRevertPrompt(
	commit: Pick<GitCommit, "hash" | "subject" | "parents">,
	branch: string | null | undefined,
): string {
	const on =
		branch === undefined
			? "the current branch"
			: (branch ?? "the detached HEAD");
	const first = [
		`Revert commit ${commit.hash.substring(0, 7)} "${commit.subject}" on ${on} with git revert.`,
		commit.parents.length > 1
			? "It is a merge commit: revert it against its first parent (-m 1), unless the history shows that is wrong."
			: null,
		`If that commit is not part of ${on}'s history, say so and stop.`,
	];
	return [
		first.filter(Boolean).join(" "),
		"If it stops on conflicts, resolve them keeping the intent of the revert, then continue. If a conflict cannot be resolved safely, stop and explain it instead of guessing.",
	].join("\n");
}
