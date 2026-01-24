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
	sessionId?: string;
}

interface NavToSettingsOverlay {
	type: "overlay";
	worktree: string;
	overlayType: "settings";
	sessionId?: string;
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
 * Build navigation options for TanStack Router.
 *
 * Note: Returns a loosely-typed object because we dynamically choose
 * between main and worktree routes. Type safety is ensured by the
 * NavTarget discriminated union at the call site.
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
