import type { OverlayState } from "../types/overlay";
import { ROUTES, WT_ROUTES } from "./routes";

export const SETUP_HOOK_PATH = ".pockode/worktree-setup.sh";

interface NavToSession {
	type: "session";
	worktree: string;
	sessionId: string;
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

type NavToFileOverlay =
	| NavToPathOverlay
	| NavToCommitOverlay
	| NavToCommitDiffOverlay;

interface NavToSettingsOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "settings";
	sessionId: string | null;
}

interface NavToTicketsOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "tickets";
	sessionId: string | null;
}

interface NavToAgentRolesOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "agent-roles";
	sessionId: string | null;
}

type NavToOverlay =
	| NavToFileOverlay
	| NavToSettingsOverlay
	| NavToTicketsOverlay
	| NavToAgentRolesOverlay;

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
 * Convert OverlayState to navigation result.
 */
export function overlayToNavigation(
	overlay: NonNullable<OverlayState>,
	worktree: string,
	sessionId: string | null,
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
			case "settings":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "settings" as const,
					sessionId,
				};
			case "tickets":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "tickets" as const,
					sessionId,
				};
			case "agent-roles":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "agent-roles" as const,
					sessionId,
				};
		}
	})();
	return buildNavigation(target);
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
			break;
		}

		case "overlay": {
			if (target.overlayType === "settings") {
				result.to = isMain ? ROUTES.settings : WT_ROUTES.settings;
				if (!isMain) {
					result.params = { worktree: target.worktree };
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
			} else if (target.overlayType === "tickets") {
				result.to = isMain ? ROUTES.tickets : WT_ROUTES.tickets;
				if (!isMain) {
					result.params = { worktree: target.worktree };
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
			} else if (target.overlayType === "agent-roles") {
				result.to = isMain ? ROUTES.agentRoles : WT_ROUTES.agentRoles;
				if (!isMain) {
					result.params = { worktree: target.worktree };
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
			} else if (target.overlayType === "commit") {
				result.to = isMain ? ROUTES.commit : WT_ROUTES.commit;
				result.params = { _splat: target.hash };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
			} else if (target.overlayType === "commit-diff") {
				result.to = isMain ? ROUTES.commitDiff : WT_ROUTES.commitDiff;
				result.params = { hash: target.hash, _splat: target.path };
				if (!isMain) {
					result.params.worktree = target.worktree;
				}
				if (target.sessionId) {
					result.search = { session: target.sessionId };
				}
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
