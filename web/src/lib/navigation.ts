import type { OverlayState } from "../types/overlay";
import { ROUTES, WT_ROUTES } from "./routes";

interface NavToSession {
	type: "session";
	worktree: string;
	sessionId: string;
}

interface NavToFileOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "staged" | "unstaged" | "file";
	path: string;
	sessionId: string | null;
}

interface NavToSettingsOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "settings";
	sessionId: string | null;
}

type NavToOverlay = NavToFileOverlay | NavToSettingsOverlay;

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
					overlayType: overlay.staged ? ("staged" as const) : ("unstaged" as const),
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
				};
			case "settings":
				return {
					type: "overlay" as const,
					worktree,
					overlayType: "settings" as const,
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
				if (target.sessionId) {
					result.search = { session: target.sessionId };
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
