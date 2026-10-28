import type { GitHistoryScope } from "./git";

/**
 * Which half of the project list is on screen: the work to triage, or the
 * archive (docs/project-ui.md §2.1).
 */
export type WorkSegment = "current" | "closed";

/**
 * Which list of the Git workspace is on screen. `changes` is the default, and
 * like `current` above it is the absence of the URL parameter.
 */
export type GitSegment = "changes" | "history" | "branches";

/**
 * Which history the History segment lists (docs/git-history-ui.md#url). The
 * history layers carry it as well as the list, so that the list beside a
 * commit, and the one Back returns to, is the one the commit was picked from.
 * Absent on an overlay means the default: the current range, unfiltered.
 */
export interface HistoryQuery {
	scope: GitHistoryScope;
	/** Commit message search; empty is no search. */
	q?: string;
	/** A path whose history is listed. */
	file?: string;
}

export const DEFAULT_HISTORY_QUERY: HistoryQuery = { scope: "current" };

/**
 * A branch as a row of the Branches list names it
 * (docs/git-branches-ui.md#the-branch). `ref` is what the row shows and
 * `git.log`'s `branch` takes — `topic`, or `origin/topic` for a remote-only
 * branch — and `remote` says which of the two it is: a local branch may itself
 * be named `origin/topic`, beside a remote-only one that reads the same.
 */
export interface BranchRef {
	ref: string;
	remote: boolean;
}

/** The list row's key for `branch`, what `findBranchRow` takes. */
export function branchRowKey(branch: BranchRef): string {
	return `${branch.remote ? "remote" : "local"}:${branch.ref}`;
}

/**
 * Which list a commit layer was opened from, carried by every layer stacked
 * under it so that its way back, and the row lit beside it, are that list's:
 * a History query (docs/git-history-ui.md#url), or the branch whose detail it
 * was picked in (docs/git-branches-ui.md#opening-a-commit). Never both.
 */
export type CommitOrigin =
	| { history?: HistoryQuery; branch?: never }
	| { branch: BranchRef; history?: never };

export type OverlayState =
	| { type: "git"; segment: GitSegment; history?: HistoryQuery }
	| { type: "diff"; path: string; staged: boolean }
	| { type: "file"; path: string; edit?: boolean }
	| ({ type: "branch" } & BranchRef)
	| ({ type: "commit"; hash: string } & CommitOrigin)
	| ({ type: "commit-diff"; hash: string; path: string } & CommitOrigin)
	| ({ type: "commit-file"; hash: string; path: string } & CommitOrigin)
	| { type: "settings" }
	| { type: "work-list"; segment: WorkSegment }
	// `segment` is not shown here — it is the segment of the list this detail
	// was opened from, carried so that Back reaches the list the reader left
	// rather than resetting them to `Current` (docs/project-ui.md §5). Same
	// device as `session`, which every overlay carries for the same reason.
	| { type: "work-detail"; workId: string; segment: WorkSegment }
	| { type: "agent-role-list" }
	| { type: "agent-role-detail"; roleId: string }
	| { type: "schedule-list" }
	| { type: "schedule-detail"; scheduleId: string }
	| null;

// The Git workspace's lists are here and its details are not: a list's bottom
// belongs to its commit bar and holds no code to talk about, while a detail is
// where the user reads what the agent changed and tells it what to change next
// (docs/git-ui.md).
const composerHiddenOverlays: NonNullable<OverlayState>["type"][] = [
	"git",
	"work-list",
	"work-detail",
	"agent-role-list",
	"agent-role-detail",
	"schedule-list",
	"schedule-detail",
];

/**
 * Whether the chat's composer is under `overlay` — the chat itself, with no
 * overlay, included. The one rule for the composer being on screen, read by
 * the chat that draws it and by a handoff deciding whether it has to take the
 * user to it.
 */
export function overlayKeepsComposer(
	overlay: OverlayState | undefined,
): boolean {
	return !overlay || !composerHiddenOverlays.includes(overlay.type);
}

/**
 * The overlays that read the repository, and so have nothing to show without
 * one. Every one of them is a layer of the Git workspace.
 */
export function isGitOverlay(overlay: OverlayState | undefined): boolean {
	return gitSegmentOf(overlay) !== null;
}

/**
 * The workspace segment a Git layer belongs to, and null for anything that is
 * not one. A detail does not carry its segment the way a work detail does: a
 * diff can only have been opened from Changes and a branch only from
 * Branches, and a commit carries the branch it was opened from or else is
 * History's, so the layer itself already says which list is its parent.
 */
export function gitSegmentOf(
	overlay: OverlayState | undefined,
): GitSegment | null {
	switch (overlay?.type) {
		case "git":
			return overlay.segment;
		case "diff":
			return "changes";
		case "branch":
			return "branches";
		case "commit":
		case "commit-diff":
		case "commit-file":
			return overlay.branch ? "branches" : "history";
		default:
			return null;
	}
}

/**
 * The history query the overlay carries, the default where it carries none —
 * including every overlay that is not a history layer.
 */
export function historyQueryOf(
	overlay: OverlayState | undefined,
): HistoryQuery {
	switch (overlay?.type) {
		case "git":
		case "commit":
		case "commit-diff":
		case "commit-file":
			return overlay.history ?? DEFAULT_HISTORY_QUERY;
		default:
			return DEFAULT_HISTORY_QUERY;
	}
}

/**
 * What a commit opened from `overlay` carries on: the branch whose detail it
 * is, or the branch or History query a commit layer already carries.
 */
export function commitOriginOf(
	overlay: OverlayState | undefined,
): CommitOrigin {
	switch (overlay?.type) {
		case "branch":
			return { branch: { ref: overlay.ref, remote: overlay.remote } };
		case "git":
			return overlay.history ? { history: overlay.history } : {};
		case "commit":
		case "commit-diff":
		case "commit-file":
			if (overlay.branch) return { branch: overlay.branch };
			return overlay.history ? { history: overlay.history } : {};
		default:
			return {};
	}
}

/**
 * Where every `History of this file` entry goes: the default range, filtered
 * to the path (docs/git-history-ui.md#entering-them).
 */
export function fileHistoryOverlay(path: string): NonNullable<OverlayState> {
	return {
		type: "git",
		segment: "history",
		history: { ...DEFAULT_HISTORY_QUERY, file: path },
	};
}
