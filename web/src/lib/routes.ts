/**
 * Centralized route path definitions.
 * Single source of truth for all route paths to avoid duplication.
 *
 * Route hierarchy:
 * - / (workspace select page in manager mode, or app in single mode)
 * - /w/$workspace/ (workspace-scoped app routes)
 *   - /w/$workspace/w/$worktree/ (worktree-scoped routes within workspace)
 */

// Base paths (used for app routes within a workspace context)
const BASE = {
	index: "/",
	session: "/s/$sessionId",
	staged: "/staged/$",
	unstaged: "/unstaged/$",
	files: "/files/$",
	commit: "/commit/$",
	commitDiff: "/commit/$hash/diff/$",
	settings: "/settings",
	works: "/works",
	workDetail: "/works/$workId",
	agentRoles: "/agent-roles",
	agentRoleDetail: "/agent-roles/$roleId",
} as const;

const WT_PREFIX = "/w/$worktree";
const WS_PREFIX = "/w/$workspace";

// Main routes (non-workspace scoped, for single mode or workspace select)
export const ROUTES = BASE;

// Worktree layout child routes (relative paths for TanStack Router)
export const WT_CHILD_ROUTES = BASE;

// Worktree-prefixed routes (full paths for navigation/matching)
export const WT_ROUTES = {
	layout: WT_PREFIX,
	index: `${WT_PREFIX}/`,
	session: `${WT_PREFIX}${BASE.session}`,
	staged: `${WT_PREFIX}${BASE.staged}`,
	unstaged: `${WT_PREFIX}${BASE.unstaged}`,
	files: `${WT_PREFIX}${BASE.files}`,
	commit: `${WT_PREFIX}${BASE.commit}`,
	commitDiff: `${WT_PREFIX}${BASE.commitDiff}`,
	settings: `${WT_PREFIX}${BASE.settings}`,
	works: `${WT_PREFIX}${BASE.works}`,
	workDetail: `${WT_PREFIX}${BASE.workDetail}`,
	agentRoles: `${WT_PREFIX}${BASE.agentRoles}`,
	agentRoleDetail: `${WT_PREFIX}${BASE.agentRoleDetail}`,
} as const;

// Workspace-prefixed routes (for manager mode)
export const WS_ROUTES = {
	layout: WS_PREFIX,
	index: `${WS_PREFIX}/`,
	session: `${WS_PREFIX}${BASE.session}`,
	staged: `${WS_PREFIX}${BASE.staged}`,
	unstaged: `${WS_PREFIX}${BASE.unstaged}`,
	files: `${WS_PREFIX}${BASE.files}`,
	commit: `${WS_PREFIX}${BASE.commit}`,
	commitDiff: `${WS_PREFIX}${BASE.commitDiff}`,
	settings: `${WS_PREFIX}${BASE.settings}`,
	works: `${WS_PREFIX}${BASE.works}`,
	workDetail: `${WS_PREFIX}${BASE.workDetail}`,
	agentRoles: `${WS_PREFIX}${BASE.agentRoles}`,
	agentRoleDetail: `${WS_PREFIX}${BASE.agentRoleDetail}`,
} as const;

// Workspace child routes (relative paths for nested routing)
export const WS_CHILD_ROUTES = BASE;

// Workspace + Worktree nested routes
export const WS_WT_ROUTES = {
	layout: `${WS_PREFIX}${WT_PREFIX}`,
	index: `${WS_PREFIX}${WT_PREFIX}/`,
	session: `${WS_PREFIX}${WT_PREFIX}${BASE.session}`,
	staged: `${WS_PREFIX}${WT_PREFIX}${BASE.staged}`,
	unstaged: `${WS_PREFIX}${WT_PREFIX}${BASE.unstaged}`,
	files: `${WS_PREFIX}${WT_PREFIX}${BASE.files}`,
	commit: `${WS_PREFIX}${WT_PREFIX}${BASE.commit}`,
	commitDiff: `${WS_PREFIX}${WT_PREFIX}${BASE.commitDiff}`,
	settings: `${WS_PREFIX}${WT_PREFIX}${BASE.settings}`,
	works: `${WS_PREFIX}${WT_PREFIX}${BASE.works}`,
	workDetail: `${WS_PREFIX}${WT_PREFIX}${BASE.workDetail}`,
	agentRoles: `${WS_PREFIX}${WT_PREFIX}${BASE.agentRoles}`,
	agentRoleDetail: `${WS_PREFIX}${WT_PREFIX}${BASE.agentRoleDetail}`,
} as const;
