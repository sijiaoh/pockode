/**
 * Centralized route path definitions.
 * Single source of truth for all route paths to avoid duplication.
 */

// Base paths (used for main routes and as child paths under worktree layout)
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
} as const;

const WT_PREFIX = "/w/$worktree";

// Main worktree routes (full paths)
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
} as const;
