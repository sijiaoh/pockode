import type { OverlayState, WorkSegment } from "../types/overlay";
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

interface NavToCommitOverlay extends NavToOverlayBase {
	overlayType: "commit";
	hash: string;
}

interface NavToCommitDiffOverlay extends NavToOverlayBase {
	overlayType: "commit-diff";
	hash: string;
	path: string;
}

interface NavToCommitFileOverlay extends NavToOverlayBase {
	overlayType: "commit-file";
	hash: string;
	path: string;
}

type NavToFileOverlay =
	| NavToPathOverlay
	| NavToCommitOverlay
	| NavToCommitDiffOverlay
	| NavToCommitFileOverlay;

interface NavToSettingsOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "settings";
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

type NavToOverlay =
	| NavToFileOverlay
	| NavToSettingsOverlay
	| NavToWorkListOverlay
	| NavToWorkDetailOverlay
	| NavToAgentRoleListOverlay
	| NavToAgentRoleDetailOverlay;

interface NavToHome {
	type: "home";
	worktree: string;
}

export type NavTarget = NavToSession | NavToOverlay | NavToHome;

interface NavigationResult {
	to: string;
	params?: Record<string, string>;
	search?: Record<string, string>;
	replace?: boolean;
}

/**
 * The query most overlay routes carry: the chat underneath it, and — on the two
 * work routes — which segment of the list the reader is in. The file routes
 * build their own, because they also carry `mode`.
 *
 * `Current` is the *absence* of `segment` rather than `segment=current`, so that
 * the default landing place has exactly one URL; it is what lets the Project
 * entry button's plain `/works` mean `Current` on its own
 * (docs/project-ui.md §5). A query with nothing in it is left off the result
 * entirely rather than handed over empty.
 */
function assignSearch(
	result: NavigationResult,
	sessionId: string | null,
	segment?: WorkSegment,
) {
	const search: Record<string, string> = {};
	if (sessionId) search.session = sessionId;
	if (segment === "closed") search.segment = segment;
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
			case "commit":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "commit" as const,
					hash: overlay.hash,
					sessionId,
				};
			case "commit-diff":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "commit-diff" as const,
					path: overlay.path,
					hash: overlay.hash,
					sessionId,
				};
			case "commit-file":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "commit-file" as const,
					path: overlay.path,
					hash: overlay.hash,
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
			} else if (target.overlayType === "work-detail") {
				result.to = isMain ? ROUTES.workDetail : WT_ROUTES.workDetail;
				result.params = { workId: target.workId };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				assignSearch(result, target.sessionId, target.segment);
			} else if (
				target.overlayType === "settings" ||
				target.overlayType === "work-list" ||
				target.overlayType === "agent-role-list"
			) {
				const routeKeyMap = {
					settings: "settings",
					"work-list": "works",
					"agent-role-list": "agentRoles",
				} as const;
				const routeKey = routeKeyMap[target.overlayType];
				result.to = isMain ? ROUTES[routeKey] : WT_ROUTES[routeKey];
				if (!isMain) {
					result.params = { worktree: target.worktree };
				}
				assignSearch(
					result,
					target.sessionId,
					target.overlayType === "work-list" ? target.segment : undefined,
				);
			} else if (target.overlayType === "commit") {
				result.to = isMain ? ROUTES.commit : WT_ROUTES.commit;
				result.params = { _splat: target.hash };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				assignSearch(result, target.sessionId);
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
				assignSearch(result, target.sessionId);
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
