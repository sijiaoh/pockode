import { useMatch, useParams } from "@tanstack/react-router";
import { ROUTES, type RouteKey, WT_ROUTES } from "../lib/routes";
import type {
	BranchSearchParams,
	CommitSearchParams,
	FileSearchParams,
	GitSearchParams,
	HistorySearchParams,
	OverlaySearchParams,
	SessionSearchParams,
} from "../router";
import type {
	CommitOrigin,
	FileOverlayMode,
	GitSegment,
	HistoryQuery,
	OverlayState,
	WorkSegment,
} from "../types/overlay";

export interface RouteInfo {
	overlay: OverlayState;
	sessionId: string | null;
	worktree: string; // "" = main
	/**
	 * Which worktree the named session's data is read from, and null when the
	 * URL does not say — which means the worktree in the path, the ordinary
	 * case. Only the session routes can carry it; see SESSION_VIEW_PARAM.
	 *
	 * Null rather than undefined because "" is a value here: it names the main
	 * worktree, the way `session_view.*` takes it.
	 */
	viewWorktree: string | null;
}

/**
 * Get the current worktree from URL params.
 * Uses useParams for efficiency - no need to match against all routes.
 */
export function useCurrentWorktree(): string {
	const params = useParams({ strict: false });
	return (params as { worktree?: string }).worktree ?? "";
}

/**
 * `Current` is the absence of the parameter, so anything that is not the one
 * word `closed` — including a URL that never carried it — is `Current`.
 */
function readSegment(search: OverlaySearchParams): WorkSegment {
	return search.segment === "closed" ? "closed" : "current";
}

/**
 * `mode=source` beside a `line` is accepted and dropped: the line already
 * implies the source, and the overlay has one shape for one state.
 */
function readFileMode(search: FileSearchParams): FileOverlayMode {
	if (search.mode === "edit") return { edit: true };
	if (search.line !== undefined) return { line: search.line };
	return search.mode === "source" ? { source: true } : {};
}

/** As `readSegment`: `changes` is whatever does not name another segment. */
function readGitSegment(search: GitSearchParams): GitSegment {
	return search.segment ?? "changes";
}

/**
 * Left off the overlay when the URL says nothing, so the default has one
 * shape. An empty `q` or `file` is no filter.
 */
function readHistoryQuery(
	search: HistorySearchParams,
): HistoryQuery | undefined {
	const { scope, q, file } = search;
	if (!scope && !q && !file) return undefined;
	return {
		scope: scope ?? "current",
		...(q ? { q } : {}),
		...(file ? { file } : {}),
	};
}

/**
 * A commit layer's origin. A URL naming both a branch and a History query —
 * typed, never written — is taken as the branch's: the narrower of the two.
 */
function readCommitOrigin(search: CommitSearchParams): CommitOrigin {
	if (search.branch) {
		return { branch: { ref: search.branch, remote: search.remote === 1 } };
	}
	const history = readHistoryQuery(search);
	return history ? { history } : {};
}

/**
 * What a matched route says, for the route the URL matched — `useRouteState`'s
 * reading of the location on screen, and `pageAt`'s of any other. Null is a
 * route with nothing to read: the index, or no match.
 */
export function routeInfoOf(
	route: RouteKey | null,
	rawParams: object,
	rawSearch: object,
	worktree: string,
): RouteInfo {
	const params = rawParams as Record<string, string | undefined>;
	switch (route) {
		case "session": {
			const search = rawSearch as SessionSearchParams;
			return {
				overlay: null,
				sessionId: params.sessionId ?? null,
				worktree,
				viewWorktree: search.from ?? null,
			};
		}
		case "staged":
		case "unstaged": {
			const search = rawSearch as OverlaySearchParams;
			return {
				overlay: {
					type: "diff",
					path: params._splat ?? "",
					staged: route === "staged",
				},
				sessionId: search.session ?? null,
				worktree,
				viewWorktree: null,
			};
		}
		case "files": {
			const search = rawSearch as FileSearchParams;
			return {
				overlay: {
					type: "file",
					path: params._splat ?? "",
					...readFileMode(search),
				},
				sessionId: search.session ?? null,
				worktree,
				viewWorktree: null,
			};
		}
		case "git": {
			const search = rawSearch as GitSearchParams;
			const segment = readGitSegment(search);
			// Only History reads it: a stray query on another segment is not
			// carried back into History when the reader switches to it.
			const history =
				segment === "history" ? readHistoryQuery(search) : undefined;
			return {
				overlay: { type: "git", segment, ...(history ? { history } : {}) },
				sessionId: search.session ?? null,
				worktree,
				viewWorktree: null,
			};
		}
		case "branch": {
			const search = rawSearch as BranchSearchParams;
			return {
				overlay: {
					type: "branch",
					ref: params._splat ?? "",
					remote: search.remote === 1,
				},
				sessionId: search.session ?? null,
				worktree,
				viewWorktree: null,
			};
		}
		case "commit": {
			const search = rawSearch as CommitSearchParams;
			return {
				overlay: {
					type: "commit",
					hash: params._splat ?? "",
					...readCommitOrigin(search),
				},
				sessionId: search.session ?? null,
				worktree,
				viewWorktree: null,
			};
		}
		case "commitDiff":
		case "commitFile": {
			const search = rawSearch as CommitSearchParams;
			return {
				overlay: {
					type: route === "commitDiff" ? "commit-diff" : "commit-file",
					hash: params.hash ?? "",
					path: params._splat ?? "",
					...readCommitOrigin(search),
				},
				sessionId: search.session ?? null,
				worktree,
				viewWorktree: null,
			};
		}
		case "settings":
		case "works":
		case "workDetail":
		case "agentRoles":
		case "agentRoleDetail":
		case "schedules":
		case "scheduleDetail": {
			const search = rawSearch as OverlaySearchParams;
			return {
				overlay: projectOverlayOf(route, params, search),
				sessionId: search.session ?? null,
				worktree,
				viewWorktree: null,
			};
		}
		default:
			return { overlay: null, sessionId: null, worktree, viewWorktree: null };
	}
}

function projectOverlayOf(
	route:
		| "settings"
		| "works"
		| "workDetail"
		| "agentRoles"
		| "agentRoleDetail"
		| "schedules"
		| "scheduleDetail",
	params: Record<string, string | undefined>,
	search: OverlaySearchParams,
): OverlayState {
	switch (route) {
		case "settings":
			return { type: "settings" };
		case "works":
			return { type: "work-list", segment: readSegment(search) };
		case "workDetail":
			return {
				type: "work-detail",
				workId: params.workId ?? "",
				segment: readSegment(search),
			};
		case "agentRoles":
			return { type: "agent-role-list" };
		case "agentRoleDetail":
			return { type: "agent-role-detail", roleId: params.roleId ?? "" };
		case "schedules":
			return { type: "schedule-list" };
		case "scheduleDetail":
			return {
				type: "schedule-detail",
				scheduleId: params.scheduleId ?? "",
			};
	}
}

export function useRouteState(): RouteInfo {
	const worktree = useCurrentWorktree();

	// Main routes
	const sessionMatch = useMatch({ from: ROUTES.session, shouldThrow: false });
	const stagedMatch = useMatch({ from: ROUTES.staged, shouldThrow: false });
	const unstagedMatch = useMatch({ from: ROUTES.unstaged, shouldThrow: false });
	const fileMatch = useMatch({ from: ROUTES.files, shouldThrow: false });

	// Worktree-prefixed routes
	const wtSessionMatch = useMatch({
		from: WT_ROUTES.session,
		shouldThrow: false,
	});
	const wtStagedMatch = useMatch({
		from: WT_ROUTES.staged,
		shouldThrow: false,
	});
	const wtUnstagedMatch = useMatch({
		from: WT_ROUTES.unstaged,
		shouldThrow: false,
	});
	const wtFileMatch = useMatch({
		from: WT_ROUTES.files,
		shouldThrow: false,
	});
	const gitMatch = useMatch({ from: ROUTES.git, shouldThrow: false });
	const wtGitMatch = useMatch({ from: WT_ROUTES.git, shouldThrow: false });
	const branchMatch = useMatch({ from: ROUTES.branch, shouldThrow: false });
	const wtBranchMatch = useMatch({
		from: WT_ROUTES.branch,
		shouldThrow: false,
	});
	const commitMatch = useMatch({
		from: ROUTES.commit,
		shouldThrow: false,
	});
	const wtCommitMatch = useMatch({
		from: WT_ROUTES.commit,
		shouldThrow: false,
	});
	const commitDiffMatch = useMatch({
		from: ROUTES.commitDiff,
		shouldThrow: false,
	});
	const wtCommitDiffMatch = useMatch({
		from: WT_ROUTES.commitDiff,
		shouldThrow: false,
	});
	const commitFileMatch = useMatch({
		from: ROUTES.commitFile,
		shouldThrow: false,
	});
	const wtCommitFileMatch = useMatch({
		from: WT_ROUTES.commitFile,
		shouldThrow: false,
	});
	const settingsMatch = useMatch({
		from: ROUTES.settings,
		shouldThrow: false,
	});
	const wtSettingsMatch = useMatch({
		from: WT_ROUTES.settings,
		shouldThrow: false,
	});
	const workDetailMatch = useMatch({
		from: ROUTES.workDetail,
		shouldThrow: false,
	});
	const wtWorkDetailMatch = useMatch({
		from: WT_ROUTES.workDetail,
		shouldThrow: false,
	});
	const worksMatch = useMatch({
		from: ROUTES.works,
		shouldThrow: false,
	});
	const wtWorksMatch = useMatch({
		from: WT_ROUTES.works,
		shouldThrow: false,
	});
	const agentRoleDetailMatch = useMatch({
		from: ROUTES.agentRoleDetail,
		shouldThrow: false,
	});
	const wtAgentRoleDetailMatch = useMatch({
		from: WT_ROUTES.agentRoleDetail,
		shouldThrow: false,
	});
	const agentRolesMatch = useMatch({
		from: ROUTES.agentRoles,
		shouldThrow: false,
	});
	const wtAgentRolesMatch = useMatch({
		from: WT_ROUTES.agentRoles,
		shouldThrow: false,
	});
	const scheduleDetailMatch = useMatch({
		from: ROUTES.scheduleDetail,
		shouldThrow: false,
	});
	const wtScheduleDetailMatch = useMatch({
		from: WT_ROUTES.scheduleDetail,
		shouldThrow: false,
	});
	const schedulesMatch = useMatch({
		from: ROUTES.schedules,
		shouldThrow: false,
	});
	const wtSchedulesMatch = useMatch({
		from: WT_ROUTES.schedules,
		shouldThrow: false,
	});

	const leaf = (
		[
			["session", sessionMatch ?? wtSessionMatch],
			["staged", stagedMatch ?? wtStagedMatch],
			["unstaged", unstagedMatch ?? wtUnstagedMatch],
			["files", fileMatch ?? wtFileMatch],
			["git", gitMatch ?? wtGitMatch],
			["branch", branchMatch ?? wtBranchMatch],
			["commit", commitMatch ?? wtCommitMatch],
			["commitDiff", commitDiffMatch ?? wtCommitDiffMatch],
			["commitFile", commitFileMatch ?? wtCommitFileMatch],
			["settings", settingsMatch ?? wtSettingsMatch],
			["workDetail", workDetailMatch ?? wtWorkDetailMatch],
			["works", worksMatch ?? wtWorksMatch],
			["agentRoleDetail", agentRoleDetailMatch ?? wtAgentRoleDetailMatch],
			["agentRoles", agentRolesMatch ?? wtAgentRolesMatch],
			["scheduleDetail", scheduleDetailMatch ?? wtScheduleDetailMatch],
			["schedules", schedulesMatch ?? wtSchedulesMatch],
		] as const
	).find(([, match]) => match !== undefined);
	if (!leaf) return routeInfoOf(null, {}, {}, worktree);
	const [route, match] = leaf;
	return routeInfoOf(route, match?.params ?? {}, match?.search ?? {}, worktree);
}
