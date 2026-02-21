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
});

export type OverlaySearchParams = z.infer<typeof overlaySearchSchema>;

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

const commitRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.commit,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const commitDiffRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: ROUTES.commitDiff,
	validateSearch: (search) => overlaySearchSchema.parse(search),
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

const wtCommitRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.commit,
	validateSearch: (search) => overlaySearchSchema.parse(search),
});

const wtCommitDiffRoute = createRoute({
	getParentRoute: () => worktreeLayoutRoute,
	path: WT_CHILD_ROUTES.commitDiff,
	validateSearch: (search) => overlaySearchSchema.parse(search),
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

const routeTree = rootRoute.addChildren([
	indexRoute,
	sessionRoute,
	stagedDiffRoute,
	unstagedDiffRoute,
	fileViewRoute,
	commitDiffRoute, // Must be before commitRoute (more specific path)
	commitRoute,
	settingsRoute,
	worksRoute,
	worktreeLayoutRoute.addChildren([
		wtIndexRoute,
		wtSessionRoute,
		wtStagedDiffRoute,
		wtUnstagedDiffRoute,
		wtFileViewRoute,
		wtCommitDiffRoute, // Must be before wtCommitRoute (more specific path)
		wtCommitRoute,
		wtSettingsRoute,
		wtWorksRoute,
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
