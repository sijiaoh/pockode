import { useMatch, useParams } from "@tanstack/react-router";
import { ROUTES, WT_ROUTES } from "../lib/routes";
import type { OverlaySearchParams } from "../router";
import type { OverlayState } from "../types/overlay";

export interface RouteInfo {
	overlay: OverlayState;
	sessionId: string | null;
	worktree: string; // "" = main
}

/**
 * Get the current worktree from URL params.
 * Uses useParams for efficiency - no need to match against all routes.
 */
export function useCurrentWorktree(): string {
	const params = useParams({ strict: false });
	return (params as { worktree?: string }).worktree ?? "";
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
	const ticketsMatch = useMatch({
		from: ROUTES.tickets,
		shouldThrow: false,
	});
	const wtTicketsMatch = useMatch({
		from: WT_ROUTES.tickets,
		shouldThrow: false,
	});
	const ticketDetailMatch = useMatch({
		from: ROUTES.ticketDetail,
		shouldThrow: false,
	});
	const wtTicketDetailMatch = useMatch({
		from: WT_ROUTES.ticketDetail,
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

	const sessionId =
		sessionMatch?.params.sessionId ?? wtSessionMatch?.params.sessionId ?? null;
	if (sessionId) {
		return { overlay: null, sessionId, worktree };
	}

	const stagedPath = stagedMatch?.params._splat ?? wtStagedMatch?.params._splat;
	if (stagedPath !== undefined) {
		const search = (stagedMatch?.search ??
			wtStagedMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "diff", path: stagedPath, staged: true },
			sessionId: search.session ?? null,
			worktree,
		};
	}

	const unstagedPath =
		unstagedMatch?.params._splat ?? wtUnstagedMatch?.params._splat;
	if (unstagedPath !== undefined) {
		const search = (unstagedMatch?.search ??
			wtUnstagedMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "diff", path: unstagedPath, staged: false },
			sessionId: search.session ?? null,
			worktree,
		};
	}

	const filePath = fileMatch?.params._splat ?? wtFileMatch?.params._splat;
	if (filePath !== undefined) {
		const search = (fileMatch?.search ??
			wtFileMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "file", path: filePath, edit: search.mode === "edit" },
			sessionId: search.session ?? null,
			worktree,
		};
	}

	const commitHash = commitMatch?.params._splat ?? wtCommitMatch?.params._splat;
	if (commitHash !== undefined) {
		const search = (commitMatch?.search ??
			wtCommitMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "commit", hash: commitHash },
			sessionId: search.session ?? null,
			worktree,
		};
	}

	const commitDiffParams = commitDiffMatch?.params ?? wtCommitDiffMatch?.params;
	if (commitDiffParams) {
		const hash = (commitDiffParams as { hash: string }).hash;
		const path = (commitDiffParams as { _splat: string })._splat;
		const search = (commitDiffMatch?.search ??
			wtCommitDiffMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "commit-diff", hash, path },
			sessionId: search.session ?? null,
			worktree,
		};
	}

	if (settingsMatch || wtSettingsMatch) {
		const search = (settingsMatch?.search ??
			wtSettingsMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "settings" },
			sessionId: search.session ?? null,
			worktree,
		};
	}

	const ticketDetailId =
		ticketDetailMatch?.params.ticketId ?? wtTicketDetailMatch?.params.ticketId;
	if (ticketDetailId) {
		const search = (ticketDetailMatch?.search ??
			wtTicketDetailMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "ticket-detail", ticketId: ticketDetailId },
			sessionId: search.session ?? null,
			worktree,
		};
	}

	if (ticketsMatch || wtTicketsMatch) {
		const search = (ticketsMatch?.search ??
			wtTicketsMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "tickets" },
			sessionId: search.session ?? null,
			worktree,
		};
	}

	if (agentRolesMatch || wtAgentRolesMatch) {
		const search = (agentRolesMatch?.search ??
			wtAgentRolesMatch?.search) as OverlaySearchParams;
		return {
			overlay: { type: "agent-roles" },
			sessionId: search.session ?? null,
			worktree,
		};
	}

	return { overlay: null, sessionId: null, worktree };
}
