import type { HistoryState } from "@tanstack/react-router";
import {
	type BranchRef,
	type CommitOrigin,
	commitOriginOf,
	type GitSegment,
	type HistoryQuery,
	type OverlayState,
	type WorkSegment,
} from "../types/overlay";
import { ROUTES, WT_ROUTES } from "./routes";
import { SESSION_VIEW_PARAM } from "./sessionView";

export const SETUP_HOOK_PATH = ".pockode/worktree-setup.sh";

interface NavToSession {
	type: "session";
	/** The worktree the user stands in, which is the one in the path. */
	worktree: string;
	sessionId: string;
	/**
	 * Which worktree to read the session out of, when that is not `worktree`.
	 * Becomes the `from` parameter — see SESSION_VIEW_PARAM. Undefined leaves it
	 * off, which is the ordinary session URL; the empty string is a value (the
	 * main worktree), not an absence.
	 */
	viewWorktree?: string;
}

interface NavToOverlayBase {
	type: "overlay";
	worktree: string;
	sessionId: string | null;
}

interface NavToPathOverlay extends NavToOverlayBase {
	overlayType: "staged" | "unstaged" | "file";
	path: string;
	edit?: boolean;
}

interface NavToBranchOverlay extends NavToOverlayBase {
	overlayType: "branch";
	ref: string;
	remote: boolean;
}

type NavToCommitOverlay = NavToOverlayBase &
	CommitOrigin & {
		overlayType: "commit";
		hash: string;
	};

type NavToCommitDiffOverlay = NavToOverlayBase &
	CommitOrigin & {
		overlayType: "commit-diff";
		hash: string;
		path: string;
	};

type NavToCommitFileOverlay = NavToOverlayBase &
	CommitOrigin & {
		overlayType: "commit-file";
		hash: string;
		path: string;
	};

type NavToFileOverlay =
	| NavToPathOverlay
	| NavToBranchOverlay
	| NavToCommitOverlay
	| NavToCommitDiffOverlay
	| NavToCommitFileOverlay;

interface NavToSettingsOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "settings";
	sessionId: string | null;
}

interface NavToGitOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "git";
	segment: GitSegment;
	/** Read on the History segment only. */
	history?: HistoryQuery;
	sessionId: string | null;
}

interface NavToWorkListOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "work-list";
	segment: WorkSegment;
	sessionId: string | null;
}

interface NavToWorkDetailOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "work-detail";
	workId: string;
	segment: WorkSegment;
	sessionId: string | null;
}

interface NavToAgentRoleListOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "agent-role-list";
	sessionId: string | null;
}

interface NavToAgentRoleDetailOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "agent-role-detail";
	roleId: string;
	sessionId: string | null;
}

interface NavToScheduleListOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "schedule-list";
	sessionId: string | null;
}

interface NavToScheduleDetailOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "schedule-detail";
	scheduleId: string;
	sessionId: string | null;
}

type NavToOverlay =
	| NavToFileOverlay
	| NavToSettingsOverlay
	| NavToGitOverlay
	| NavToWorkListOverlay
	| NavToWorkDetailOverlay
	| NavToAgentRoleListOverlay
	| NavToAgentRoleDetailOverlay
	| NavToScheduleListOverlay
	| NavToScheduleDetailOverlay;

interface NavToHome {
	type: "home";
	worktree: string;
}

export type NavTarget = NavToSession | NavToOverlay | NavToHome;

interface NavigationResult {
	to: string;
	params?: Record<string, string>;
	/**
	 * A number only where the route's schema takes one (`remote=1`): the
	 * router quotes a string that would parse as JSON.
	 */
	search?: Record<string, string | number>;
	replace?: boolean;
}

const REVIEW_FROM_LIST_KEY = "reviewFromList";

/**
 * The history state of a review pushed from the Changes list, which is what
 * says the entry behind it is that list. Every move inside the review replaces
 * with `state: true` to carry it, and leaving the review goes back to that
 * entry instead of replacing the review with a second copy of the list
 * (docs/git-changes-ui.md#the-review-layer). A review reached any other way —
 * a link, a URL typed in — has nothing behind it to go back to.
 *
 * Cast because the router's HistoryState is declared in @tanstack/history,
 * which this package does not depend on directly and so cannot augment.
 */
export const REVIEW_FROM_LIST_STATE = {
	[REVIEW_FROM_LIST_KEY]: true,
} as HistoryState;

export function isReviewFromList(state: unknown): boolean {
	return (
		typeof state === "object" &&
		state !== null &&
		(state as Record<string, unknown>)[REVIEW_FROM_LIST_KEY] === true
	);
}

/**
 * The query most overlay routes carry: the chat underneath it, and — on the two
 * work routes and the Git workspace — which segment of the list the reader is
 * in. The file routes build their own, because they also carry `mode`.
 *
 * A default segment (`current`, `changes`) is the *absence* of `segment`
 * rather than spelled out, so that the default landing place has exactly one
 * URL; it is what lets the Project entry button's plain `/works` mean
 * `Current` on its own (docs/project-ui.md §5). A query with nothing in it is
 * left off the result entirely rather than handed over empty. The History
 * segment's query follows the same rule: `scope=current` is never written.
 */
function assignSearch(
	result: NavigationResult,
	sessionId: string | null,
	segment?: WorkSegment | GitSegment,
	history?: HistoryQuery,
) {
	const search: Record<string, string> = {};
	if (sessionId) search.session = sessionId;
	if (segment && segment !== "current" && segment !== "changes") {
		search.segment = segment;
	}
	if (history) {
		if (history.scope !== "current") search.scope = history.scope;
		if (history.q) search.q = history.q;
		if (history.file) search.file = history.file;
	}
	if (Object.keys(search).length > 0) result.search = search;
}

/**
 * A branch as its detail's URL names it, and a commit opened from it: `remote=1`
 * for a remote-only branch (docs/git-branches-ui.md#the-branch).
 */
function assignBranchSearch(
	result: NavigationResult,
	branch: BranchRef,
	withRef: boolean,
) {
	const search: Record<string, string | number> = { ...result.search };
	if (withRef) search.branch = branch.ref;
	if (branch.remote) search.remote = 1;
	if (Object.keys(search).length > 0) result.search = search;
}

/**
 * Convert OverlayState to navigation result.
 *
 * `options.replace` is for the cases where the overlay is being *corrected*
 * rather than opened — a file renamed under it, say. Pushing there would leave
 * a history entry pointing at a path that no longer resolves.
 */
export function overlayToNavigation(
	overlay: NonNullable<OverlayState>,
	worktree: string,
	sessionId: string | null,
	options?: { replace?: boolean },
): NavigationResult {
	const target: NavToOverlay = (() => {
		switch (overlay.type) {
			case "git":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "git" as const,
					segment: overlay.segment,
					history: overlay.history,
					sessionId,
				};
			case "diff":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: overlay.staged
						? ("staged" as const)
						: ("unstaged" as const),
					path: overlay.path,
					sessionId,
				};
			case "file":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "file" as const,
					path: overlay.path,
					sessionId,
					edit: overlay.edit,
				};
			case "branch":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "branch" as const,
					ref: overlay.ref,
					remote: overlay.remote,
					sessionId,
				};
			case "commit":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "commit" as const,
					hash: overlay.hash,
					...commitOriginOf(overlay),
					sessionId,
				};
			case "commit-diff":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "commit-diff" as const,
					path: overlay.path,
					hash: overlay.hash,
					...commitOriginOf(overlay),
					sessionId,
				};
			case "commit-file":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "commit-file" as const,
					path: overlay.path,
					hash: overlay.hash,
					...commitOriginOf(overlay),
					sessionId,
				};
			case "settings":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "settings" as const,
					sessionId,
				};
			case "work-list":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "work-list" as const,
					segment: overlay.segment,
					sessionId,
				};
			case "work-detail":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "work-detail" as const,
					workId: overlay.workId,
					segment: overlay.segment,
					sessionId,
				};
			case "agent-role-list":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "agent-role-list" as const,
					sessionId,
				};
			case "agent-role-detail":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "agent-role-detail" as const,
					roleId: overlay.roleId,
					sessionId,
				};
			case "schedule-list":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "schedule-list" as const,
					sessionId,
				};
			case "schedule-detail":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "schedule-detail" as const,
					scheduleId: overlay.scheduleId,
					sessionId,
				};
		}
	})();
	return buildNavigation(target, options);
}

/**
 * Build navigation options for TanStack Router.
 */
export function buildNavigation(
	target: NavTarget,
	options?: { replace?: boolean },
): NavigationResult {
	const isMain = !target.worktree;
	const result: NavigationResult = { to: "" };

	if (options?.replace) {
		result.replace = true;
	}

	switch (target.type) {
		case "session": {
			if (isMain) {
				result.to = ROUTES.session;
				result.params = { sessionId: target.sessionId };
			} else {
				result.to = WT_ROUTES.session;
				result.params = {
					worktree: target.worktree,
					sessionId: target.sessionId,
				};
			}
			if (target.viewWorktree !== undefined) {
				result.search = { [SESSION_VIEW_PARAM]: target.viewWorktree };
			}
			break;
		}

		case "overlay": {
			if (target.overlayType === "agent-role-detail") {
				result.to = isMain ? ROUTES.agentRoleDetail : WT_ROUTES.agentRoleDetail;
				result.params = { roleId: target.roleId };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				assignSearch(result, target.sessionId);
			} else if (target.overlayType === "schedule-detail") {
				result.to = isMain ? ROUTES.scheduleDetail : WT_ROUTES.scheduleDetail;
				result.params = { scheduleId: target.scheduleId };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				assignSearch(result, target.sessionId);
			} else if (target.overlayType === "work-detail") {
				result.to = isMain ? ROUTES.workDetail : WT_ROUTES.workDetail;
				result.params = { workId: target.workId };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				assignSearch(result, target.sessionId, target.segment);
			} else if (
				target.overlayType === "settings" ||
				target.overlayType === "git" ||
				target.overlayType === "work-list" ||
				target.overlayType === "agent-role-list" ||
				target.overlayType === "schedule-list"
			) {
				const routeKeyMap = {
					settings: "settings",
					git: "git",
					"work-list": "works",
					"agent-role-list": "agentRoles",
					"schedule-list": "schedules",
				} as const;
				const routeKey = routeKeyMap[target.overlayType];
				result.to = isMain ? ROUTES[routeKey] : WT_ROUTES[routeKey];
				if (!isMain) {
					result.params = { worktree: target.worktree };
				}
				assignSearch(
					result,
					target.sessionId,
					target.overlayType === "work-list" || target.overlayType === "git"
						? target.segment
						: undefined,
					target.overlayType === "git" && target.segment === "history"
						? target.history
						: undefined,
				);
			} else if (target.overlayType === "branch") {
				result.to = isMain ? ROUTES.branch : WT_ROUTES.branch;
				result.params = { _splat: target.ref };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				assignSearch(result, target.sessionId);
				assignBranchSearch(result, target, false);
			} else if (target.overlayType === "commit") {
				result.to = isMain ? ROUTES.commit : WT_ROUTES.commit;
				result.params = { _splat: target.hash };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				assignSearch(result, target.sessionId, undefined, target.history);
				if (target.branch) assignBranchSearch(result, target.branch, true);
			} else if (
				target.overlayType === "commit-diff" ||
				target.overlayType === "commit-file"
			) {
				const route =
					target.overlayType === "commit-diff" ? "commitDiff" : "commitFile";
				result.to = isMain ? ROUTES[route] : WT_ROUTES[route];
				result.params = { hash: target.hash, _splat: target.path };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				assignSearch(result, target.sessionId, undefined, target.history);
				if (target.branch) assignBranchSearch(result, target.branch, true);
			} else {
				const routeMap = {
					staged: isMain ? ROUTES.staged : WT_ROUTES.staged,
					unstaged: isMain ? ROUTES.unstaged : WT_ROUTES.unstaged,
					file: isMain ? ROUTES.files : WT_ROUTES.files,
				} as const;

				result.to = routeMap[target.overlayType];
				result.params = { _splat: target.path };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				if (target.sessionId || target.edit) {
					result.search = {};
					if (target.sessionId) {
						result.search.session = target.sessionId;
					}
					if (target.edit) {
						result.search.mode = "edit";
					}
				}
			}
			break;
		}

		case "home": {
			if (isMain) {
				result.to = ROUTES.index;
			} else {
				result.to = WT_ROUTES.index;
				result.params = { worktree: target.worktree };
			}
			break;
		}
	}

	return result;
}
