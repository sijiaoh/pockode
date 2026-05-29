import type { OverlayState } from "../types/overlay";
import { ROUTES, WS_ROUTES, WS_WT_ROUTES, WT_ROUTES } from "./routes";

export const SETUP_HOOK_PATH = ".pockode/worktree-setup.sh";

interface NavToSession {
	type: "session";
	worktree: string;
	workspace?: string | null;
	sessionId: string;
}

interface NavToOverlayBase {
	type: "overlay";
	worktree: string;
	workspace?: string | null;
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

type NavToFileOverlay =
	| NavToPathOverlay
	| NavToCommitOverlay
	| NavToCommitDiffOverlay;

interface NavToSettingsOverlay {
	type: "overlay";
	worktree: string;
	workspace?: string | null;
	overlayType: "settings";
	sessionId: string | null;
}

interface NavToWorkListOverlay {
	type: "overlay";
	worktree: string;
	workspace?: string | null;
	overlayType: "work-list";
	sessionId: string | null;
}

interface NavToWorkDetailOverlay {
	type: "overlay";
	worktree: string;
	workspace?: string | null;
	overlayType: "work-detail";
	workId: string;
	sessionId: string | null;
}

interface NavToAgentRoleListOverlay {
	type: "overlay";
	worktree: string;
	workspace?: string | null;
	overlayType: "agent-role-list";
	sessionId: string | null;
}

interface NavToAgentRoleDetailOverlay {
	type: "overlay";
	worktree: string;
	workspace?: string | null;
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
	workspace?: string | null;
}

interface NavToWorkspaceSelect {
	type: "workspace-select";
}

export type NavTarget =
	| NavToSession
	| NavToOverlay
	| NavToHome
	| NavToWorkspaceSelect;

interface NavigationResult {
	to: string;
	params?: Record<string, string>;
	search?: Record<string, string>;
	replace?: boolean;
}

/**
 * Convert OverlayState to navigation result.
 */
export function overlayToNavigation(
	overlay: NonNullable<OverlayState>,
	worktree: string,
	sessionId: string | null,
	workspace?: string | null,
): NavigationResult {
	const target: NavToOverlay = (() => {
		switch (overlay.type) {
			case "diff":
				return {
					type: "overlay" as const,
					worktree,
					workspace,
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
					workspace,
					overlayType: "file" as const,
					path: overlay.path,
					sessionId,
					edit: overlay.edit,
				};
			case "commit":
				return {
					type: "overlay" as const,
					worktree,
					workspace,
					overlayType: "commit" as const,
					hash: overlay.hash,
					sessionId,
				};
			case "commit-diff":
				return {
					type: "overlay" as const,
					worktree,
					workspace,
					overlayType: "commit-diff" as const,
					path: overlay.path,
					hash: overlay.hash,
					sessionId,
				};
			case "settings":
				return {
					type: "overlay" as const,
					worktree,
					workspace,
					overlayType: "settings" as const,
					sessionId,
				};
			case "work-list":
				return {
					type: "overlay" as const,
					worktree,
					workspace,
					overlayType: "work-list" as const,
					sessionId,
				};
			case "work-detail":
				return {
					type: "overlay" as const,
					worktree,
					workspace,
					overlayType: "work-detail" as const,
					workId: overlay.workId,
					sessionId,
				};
			case "agent-role-list":
				return {
					type: "overlay" as const,
					worktree,
					workspace,
					overlayType: "agent-role-list" as const,
					sessionId,
				};
			case "agent-role-detail":
				return {
					type: "overlay" as const,
					worktree,
					workspace,
					overlayType: "agent-role-detail" as const,
					roleId: overlay.roleId,
					sessionId,
				};
		}
	})();
	return buildNavigation(target);
}

/**
 * Get the appropriate route set based on workspace and worktree context.
 */
function getRoutes(workspace: string | null | undefined, worktree: string) {
	const hasWorkspace = !!workspace;
	const hasWorktree = !!worktree;

	if (hasWorkspace && hasWorktree) {
		return { routes: WS_WT_ROUTES, prefix: "ws-wt" as const };
	}
	if (hasWorkspace) {
		return { routes: WS_ROUTES, prefix: "ws" as const };
	}
	if (hasWorktree) {
		return { routes: WT_ROUTES, prefix: "wt" as const };
	}
	return { routes: ROUTES, prefix: "main" as const };
}

/**
 * Build navigation options for TanStack Router.
 */
export function buildNavigation(
	target: NavTarget,
	options?: { replace?: boolean },
): NavigationResult {
	const result: NavigationResult = { to: "" };

	if (options?.replace) {
		result.replace = true;
	}

	if (target.type === "workspace-select") {
		result.to = ROUTES.index;
		return result;
	}

	const workspace = "workspace" in target ? target.workspace : null;
	const worktree = "worktree" in target ? target.worktree : "";
	const { routes, prefix } = getRoutes(workspace, worktree);
	const hasWorkspace = prefix === "ws" || prefix === "ws-wt";
	const hasWorktree = prefix === "wt" || prefix === "ws-wt";

	switch (target.type) {
		case "session": {
			result.to = routes.session;
			result.params = { sessionId: target.sessionId };
			if (hasWorkspace && workspace) {
				result.params.workspace = workspace;
			}
			if (hasWorktree) {
				result.params.worktree = worktree;
			}
			break;
		}

		case "overlay": {
			if (target.overlayType === "agent-role-detail") {
				result.to = routes.agentRoleDetail;
				result.params = { roleId: target.roleId };
				if (hasWorkspace && workspace) {
					result.params.workspace = workspace;
				}
				if (hasWorktree) {
					result.params.worktree = worktree;
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
			} else if (target.overlayType === "work-detail") {
				result.to = routes.workDetail;
				result.params = { workId: target.workId };
				if (hasWorkspace && workspace) {
					result.params.workspace = workspace;
				}
				if (hasWorktree) {
					result.params.worktree = worktree;
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
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
				result.to = routes[routeKey];
				result.params = {};
				if (hasWorkspace && workspace) {
					result.params.workspace = workspace;
				}
				if (hasWorktree) {
					result.params.worktree = worktree;
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
			} else if (target.overlayType === "commit") {
				result.to = routes.commit;
				result.params = { _splat: target.hash };
				if (hasWorkspace && workspace) {
					result.params.workspace = workspace;
				}
				if (hasWorktree) {
					result.params.worktree = worktree;
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
			} else if (target.overlayType === "commit-diff") {
				result.to = routes.commitDiff;
				result.params = { hash: target.hash, _splat: target.path };
				if (hasWorkspace && workspace) {
					result.params.workspace = workspace;
				}
				if (hasWorktree) {
					result.params.worktree = worktree;
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
			} else {
				const routeKeyMap = {
					staged: "staged",
					unstaged: "unstaged",
					file: "files",
				} as const;
				const routeKey = routeKeyMap[target.overlayType];
				result.to = routes[routeKey];
				result.params = { _splat: target.path };
				if (hasWorkspace && workspace) {
					result.params.workspace = workspace;
				}
				if (hasWorktree) {
					result.params.worktree = worktree;
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
			result.to = routes.index;
			result.params = {};
			if (hasWorkspace && workspace) {
				result.params.workspace = workspace;
			}
			if (hasWorktree) {
				result.params.worktree = worktree;
			}
			break;
		}
	}

	return result;
}
