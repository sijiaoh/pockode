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

export type OverlayState =
	| { type: "git"; segment: GitSegment; history?: HistoryQuery }
	| { type: "diff"; path: string; staged: boolean }
	| { type: "file"; path: string; edit?: boolean }
	| { type: "commit"; hash: string; history?: HistoryQuery }
	| {
			type: "commit-diff";
			hash: string;
			path: string;
			history?: HistoryQuery;
	  }
	| {
			type: "commit-file";
			hash: string;
			path: string;
			history?: HistoryQuery;
	  }
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
 * diff can only have been opened from Changes and a commit only from History,
 * so the layer itself already says which list is its parent.
 */
export function gitSegmentOf(
	overlay: OverlayState | undefined,
): GitSegment | null {
	switch (overlay?.type) {
		case "git":
			return overlay.segment;
		case "diff":
			return "changes";
		case "commit":
		case "commit-diff":
		case "commit-file":
			return "history";
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
