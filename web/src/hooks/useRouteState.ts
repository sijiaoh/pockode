import { useMatch, useParams } from "@tanstack/react-router";
import { ROUTES, WS_ROUTES, WS_WT_ROUTES, WT_ROUTES } from "../lib/routes";
import type { OverlaySearchParams } from "../router";
import type { OverlayState } from "../types/overlay";

export interface RouteInfo {
	overlay: OverlayState;
	sessionId: string | null;
	worktree: string; // "" = main
	workspace: string | null; // null = single mode, string = workspace ID
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
 * Get the current workspace from URL params.
 * Returns null if not in workspace mode.
 */
export function useCurrentWorkspace(): string | null {
	const params = useParams({ strict: false });
	return (params as { workspace?: string }).workspace ?? null;
}

export function useRouteState(): RouteInfo {
	const worktree = useCurrentWorktree();
	const workspace = useCurrentWorkspace();

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

	// Workspace-prefixed routes
	const wsSessionMatch = useMatch({
		from: WS_ROUTES.session,
		shouldThrow: false,
	});
	const wsStagedMatch = useMatch({
		from: WS_ROUTES.staged,
		shouldThrow: false,
	});
	const wsUnstagedMatch = useMatch({
		from: WS_ROUTES.unstaged,
		shouldThrow: false,
	});
	const wsFileMatch = useMatch({
		from: WS_ROUTES.files,
		shouldThrow: false,
	});
	const wsCommitMatch = useMatch({
		from: WS_ROUTES.commit,
		shouldThrow: false,
	});
	const wsCommitDiffMatch = useMatch({
		from: WS_ROUTES.commitDiff,
		shouldThrow: false,
	});
	const wsSettingsMatch = useMatch({
		from: WS_ROUTES.settings,
		shouldThrow: false,
	});
	const wsWorkDetailMatch = useMatch({
		from: WS_ROUTES.workDetail,
		shouldThrow: false,
	});
	const wsWorksMatch = useMatch({
		from: WS_ROUTES.works,
		shouldThrow: false,
	});
	const wsAgentRoleDetailMatch = useMatch({
		from: WS_ROUTES.agentRoleDetail,
		shouldThrow: false,
	});
	const wsAgentRolesMatch = useMatch({
		from: WS_ROUTES.agentRoles,
		shouldThrow: false,
	});

	// Workspace + Worktree routes
	const wsWtSessionMatch = useMatch({
		from: WS_WT_ROUTES.session,
		shouldThrow: false,
	});
	const wsWtStagedMatch = useMatch({
		from: WS_WT_ROUTES.staged,
		shouldThrow: false,
	});
	const wsWtUnstagedMatch = useMatch({
		from: WS_WT_ROUTES.unstaged,
		shouldThrow: false,
	});
	const wsWtFileMatch = useMatch({
		from: WS_WT_ROUTES.files,
		shouldThrow: false,
	});
	const wsWtCommitMatch = useMatch({
		from: WS_WT_ROUTES.commit,
		shouldThrow: false,
	});
	const wsWtCommitDiffMatch = useMatch({
		from: WS_WT_ROUTES.commitDiff,
		shouldThrow: false,
	});
	const wsWtSettingsMatch = useMatch({
		from: WS_WT_ROUTES.settings,
		shouldThrow: false,
	});
	const wsWtWorkDetailMatch = useMatch({
		from: WS_WT_ROUTES.workDetail,
		shouldThrow: false,
	});
	const wsWtWorksMatch = useMatch({
		from: WS_WT_ROUTES.works,
		shouldThrow: false,
	});
	const wsWtAgentRoleDetailMatch = useMatch({
		from: WS_WT_ROUTES.agentRoleDetail,
		shouldThrow: false,
	});
	const wsWtAgentRolesMatch = useMatch({
		from: WS_WT_ROUTES.agentRoles,
		shouldThrow: false,
	});

	const sessionId =
		sessionMatch?.params.sessionId ??
		wtSessionMatch?.params.sessionId ??
		wsSessionMatch?.params.sessionId ??
		wsWtSessionMatch?.params.sessionId ??
		null;
	if (sessionId) {
		return { overlay: null, sessionId, worktree, workspace };
	}

	const stagedPath =
		stagedMatch?.params._splat ??
		wtStagedMatch?.params._splat ??
		wsStagedMatch?.params._splat ??
		wsWtStagedMatch?.params._splat;
	if (stagedPath !== undefined) {
		const search = (stagedMatch?.search ??
			wtStagedMatch?.search ??
			wsStagedMatch?.search ??
			wsWtStagedMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "diff", path: stagedPath, staged: true },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	const unstagedPath =
		unstagedMatch?.params._splat ??
		wtUnstagedMatch?.params._splat ??
		wsUnstagedMatch?.params._splat ??
		wsWtUnstagedMatch?.params._splat;
	if (unstagedPath !== undefined) {
		const search = (unstagedMatch?.search ??
			wtUnstagedMatch?.search ??
			wsUnstagedMatch?.search ??
			wsWtUnstagedMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "diff", path: unstagedPath, staged: false },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	const filePath =
		fileMatch?.params._splat ??
		wtFileMatch?.params._splat ??
		wsFileMatch?.params._splat ??
		wsWtFileMatch?.params._splat;
	if (filePath !== undefined) {
		const search = (fileMatch?.search ??
			wtFileMatch?.search ??
			wsFileMatch?.search ??
			wsWtFileMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "file", path: filePath, edit: search.mode === "edit" },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	const commitHash =
		commitMatch?.params._splat ??
		wtCommitMatch?.params._splat ??
		wsCommitMatch?.params._splat ??
		wsWtCommitMatch?.params._splat;
	if (commitHash !== undefined) {
		const search = (commitMatch?.search ??
			wtCommitMatch?.search ??
			wsCommitMatch?.search ??
			wsWtCommitMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "commit", hash: commitHash },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	const commitDiffParams =
		commitDiffMatch?.params ??
		wtCommitDiffMatch?.params ??
		wsCommitDiffMatch?.params ??
		wsWtCommitDiffMatch?.params;
	if (commitDiffParams) {
		const hash = (commitDiffParams as { hash: string }).hash;
		const path = (commitDiffParams as { _splat: string })._splat;
		const search = (commitDiffMatch?.search ??
			wtCommitDiffMatch?.search ??
			wsCommitDiffMatch?.search ??
			wsWtCommitDiffMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "commit-diff", hash, path },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	if (
		settingsMatch ||
		wtSettingsMatch ||
		wsSettingsMatch ||
		wsWtSettingsMatch
	) {
		const search = (settingsMatch?.search ??
			wtSettingsMatch?.search ??
			wsSettingsMatch?.search ??
			wsWtSettingsMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "settings" },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	const workDetailParams =
		workDetailMatch?.params ??
		wtWorkDetailMatch?.params ??
		wsWorkDetailMatch?.params ??
		wsWtWorkDetailMatch?.params;
	if (workDetailParams) {
		const workId = (workDetailParams as { workId: string }).workId;
		const search = (workDetailMatch?.search ??
			wtWorkDetailMatch?.search ??
			wsWorkDetailMatch?.search ??
			wsWtWorkDetailMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "work-detail", workId },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	if (worksMatch || wtWorksMatch || wsWorksMatch || wsWtWorksMatch) {
		const search = (worksMatch?.search ??
			wtWorksMatch?.search ??
			wsWorksMatch?.search ??
			wsWtWorksMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "work-list" },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	const agentRoleDetailParams =
		agentRoleDetailMatch?.params ??
		wtAgentRoleDetailMatch?.params ??
		wsAgentRoleDetailMatch?.params ??
		wsWtAgentRoleDetailMatch?.params;
	if (agentRoleDetailParams) {
		const roleId = (agentRoleDetailParams as { roleId: string }).roleId;
		const search = (agentRoleDetailMatch?.search ??
			wtAgentRoleDetailMatch?.search ??
			wsAgentRoleDetailMatch?.search ??
			wsWtAgentRoleDetailMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "agent-role-detail", roleId },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	if (
		agentRolesMatch ||
		wtAgentRolesMatch ||
		wsAgentRolesMatch ||
		wsWtAgentRolesMatch
	) {
		const search = (agentRolesMatch?.search ??
			wtAgentRolesMatch?.search ??
			wsAgentRolesMatch?.search ??
			wsWtAgentRolesMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "agent-role-list" },
			sessionId: search.session ?? null,
			worktree,
			workspace,
		};
	}

	return { overlay: null, sessionId: null, worktree, workspace };
}
