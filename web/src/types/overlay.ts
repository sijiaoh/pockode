/**
 * Which half of the project list is on screen: the work to triage, or the
 * archive (docs/project-ui.md §2.1).
 */
export type WorkSegment = "current" | "closed";

export type OverlayState =
	| { type: "diff"; path: string; staged: boolean }
	| { type: "file"; path: string; edit?: boolean }
	| { type: "commit"; hash: string }
	| { type: "commit-diff"; hash: string; path: string }
	| { type: "commit-file"; hash: string; path: string }
	| { type: "settings" }
	| { type: "work-list"; segment: WorkSegment }
	// `segment` is not shown here — it is the segment of the list this detail
	// was opened from, carried so that Back reaches the list the reader left
	// rather than resetting them to `Current` (docs/project-ui.md §5). Same
	// device as `session`, which every overlay carries for the same reason.
	| { type: "work-detail"; workId: string; segment: WorkSegment }
	| { type: "agent-role-list" }
	| { type: "agent-role-detail"; roleId: string }
	| null;
