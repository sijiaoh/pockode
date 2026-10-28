import {
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { z } from "zod";
import AppShell from "./components/AppShell";
import { ROUTES, WT_CHILD_ROUTES, WT_ROUTES } from "./lib/routes";

const overlaySearchSchema = z.object({
	session: z.string().optional(),
	mode: z.enum(["edit"]).optional(),
	// Which half of the project list is on screen (docs/project-ui.md §5). Only
	// `closed` is ever written — `current` is the absence of the parameter, so
	// one state has one URL. `current` is accepted as well, so that a URL which
	// spells the default out still resolves; anything else fails the schema,
	// as `mode` does.
	segment: z.enum(["current", "closed"]).optional(),
});

export type OverlaySearchParams = z.infer<typeof overlaySearchSchema>;

/**
 * The History segment's query (docs/git-history-ui.md#url), on the list and on
 * the commit layers alike. `scope=current` is the default, accepted spelled
 * out and never written.
 */
const historySearchSchema = z.object({
	scope: z.enum(["current", "all", "mainline"]).optional(),
	// Coerced: the router reads `q=2024` from a typed or shared URL as a
	// number, and a search for a year or an issue number is a string.
	q: z.coerce.string().optional(),
	file: z.coerce.string().optional(),
});

export type HistorySearchParams = z.infer<typeof historySearchSchema>;

/**
 * The Git workspace's own query: the same `session`, and a `segment` with its
 * own words. As with the project list, only the non-default segments are ever
 * written, and the default is accepted spelled out.
 */
const gitSearchSchema = historySearchSchema.extend({
	session: z.string().optional(),
	segment: z.enum(["changes", "history", "branches"]).optional(),
});

export type GitSearchParams = z.infer<typeof gitSearchSchema>;

/**
 * A branch detail's: `remote=1` names a remote-only branch, whose `ref` a
 * local branch may share (docs/git-branches-ui.md#the-branch). A number, not
 * a string: the router writes the validated value back, and quotes a string
 * that would parse as JSON (`remote=%221%22`).
 */
const branchSearchSchema = overlaySearchSchema.extend({
	remote: z.coerce.number().optional(),
});

export type BranchSearchParams = z.infer<typeof branchSearchSchema>;

/**
 * The commit layers': the History query of the list a commit was opened from,
 * or `branch` (and `remote=1`) for one opened from a branch's detail
 * (docs/git-branches-ui.md#opening-a-commit). `branch` is coerced as `q` is:
 * a branch may be named `2024`.
 */
const commitSearchSchema = overlaySearchSchema
	.extend(historySearchSchema.shape)
	.extend({
		branch: z.coerce.string().optional(),
		remote: z.coerce.number().optional(),
	});

export type CommitSearchParams = z.infer<typeof commitSearchSchema>;

/**
 * The session routes carry one parameter, and only they do: which worktree the
 * session's data is read out of. `""` is the main worktree, so the value is
 * accepted empty and an absent parameter is the ordinary case — see
 * SESSION_VIEW_PARAM in lib/sessionView.ts for the whole convention.
 */
const sessionSearchSchema = z.object({
	from: z.string().optional(),
});

export type SessionSearchParams = z.infer<typeof sessionSearchSchema>;

const rootRoute = createRootRoute({
	component: AppShell,
});

// Main routes
const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.index,
});

const sessionRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.session,
	validateSearch: (search) => sessionSearchSchema.parse(search),
});

const stagedDiffRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.staged,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const unstagedDiffRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.unstaged,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const fileViewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.files,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const gitRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.git,
	validateSearch: (search) => gitSearchSchema.parse(search),
});

const branchRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.branch,
	validateSearch: (search) => branchSearchSchema.parse(search),
});

const commitRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.commit,
	validateSearch: (search) => commitSearchSchema.parse(search),
});

const commitDiffRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.commitDiff,
	validateSearch: (search) => commitSearchSchema.parse(search),
});

const commitFileRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.commitFile,
	validateSearch: (search) => commitSearchSchema.parse(search),
});

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.settings,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const worksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.works,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const workDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.workDetail,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const agentRolesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.agentRoles,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const agentRoleDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.agentRoleDetail,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const schedulesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.schedules,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const scheduleDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.scheduleDetail,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

// Worktree-prefixed routes
const worktreeLayoutRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WT_ROUTES.layout,
});

const wtIndexRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.index,
});

const wtSessionRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.session,
	validateSearch: (search) => sessionSearchSchema.parse(search),
});

const wtStagedDiffRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.staged,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtUnstagedDiffRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.unstaged,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtFileViewRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.files,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtGitRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.git,
	validateSearch: (search) => gitSearchSchema.parse(search),
});

const wtBranchRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.branch,
	validateSearch: (search) => branchSearchSchema.parse(search),
});

const wtCommitRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.commit,
	validateSearch: (search) => commitSearchSchema.parse(search),
});

const wtCommitDiffRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.commitDiff,
	validateSearch: (search) => commitSearchSchema.parse(search),
});

const wtCommitFileRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.commitFile,
	validateSearch: (search) => commitSearchSchema.parse(search),
});

const wtSettingsRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.settings,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtWorksRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.works,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtWorkDetailRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.workDetail,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtAgentRolesRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.agentRoles,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtAgentRoleDetailRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.agentRoleDetail,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtSchedulesRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.schedules,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtScheduleDetailRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.scheduleDetail,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

export const routeTree = rootRoute.addChildren([
	indexRoute,
	sessionRoute,
	stagedDiffRoute,
	unstagedDiffRoute,
	fileViewRoute,
	gitRoute,
	branchRoute,
	commitDiffRoute, // Must be before commitRoute (more specific path)
	commitFileRoute, // Must be before commitRoute (more specific path)
	commitRoute,
	settingsRoute,
	workDetailRoute, // Must be before worksRoute (more specific path)
	worksRoute,
	agentRoleDetailRoute, // Must be before agentRolesRoute (more specific path)
	agentRolesRoute,
	scheduleDetailRoute, // Must be before schedulesRoute (more specific path)
	schedulesRoute,
	worktreeLayoutRoute.addChildren([
		wtIndexRoute,
		wtSessionRoute,
		wtStagedDiffRoute,
		wtUnstagedDiffRoute,
		wtFileViewRoute,
		wtGitRoute,
		wtBranchRoute,
		wtCommitDiffRoute, // Must be before wtCommitRoute (more specific path)
		wtCommitFileRoute, // Must be before wtCommitRoute (more specific path)
		wtCommitRoute,
		wtSettingsRoute,
		wtWorkDetailRoute, // Must be before wtWorksRoute (more specific path)
		wtWorksRoute,
		wtAgentRoleDetailRoute, // Must be before wtAgentRolesRoute (more specific path)
		wtAgentRolesRoute,
		wtScheduleDetailRoute, // Must be before wtSchedulesRoute (more specific path)
		wtSchedulesRoute,
	]),
]);

export const router = createRouter({
	routeTree,
	defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
