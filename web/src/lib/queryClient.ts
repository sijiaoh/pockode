import { QueryClient } from "@tanstack/react-query";
import { HttpError } from "./api";
import { authActions } from "./authStore";
import { setOnWorktreeSwitched } from "./wsStore";

function isUnauthorized(error: unknown): boolean {
	return error instanceof HttpError && error.status === 401;
}

/** Attempts after the first, before a query is allowed to surface its error. */
export const DEFAULT_RETRY_COUNT = 3;

const WORKTREE_DEPENDENT_QUERY_KEYS = [
	"git-status",
	"git-diff",
	"sessions",
	"contents",
	"file-search",
];

export function createQueryClient(): QueryClient {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: (failureCount, error) => {
					if (isUnauthorized(error)) {
						return false;
					}
					return failureCount < DEFAULT_RETRY_COUNT;
				},
			},
			mutations: {
				retry: false,
			},
		},
	});

	queryClient.getQueryCache().subscribe((event) => {
		if (event.type === "updated" && isUnauthorized(event.query.state.error)) {
			authActions.logout();
		}
	});

	queryClient.getMutationCache().subscribe((event) => {
		if (
			event.type === "updated" &&
			isUnauthorized(event.mutation?.state.error)
		) {
			authActions.logout();
		}
	});

	// Invalidate worktree-dependent caches after switch completes.
	// invalidateQueries forces refetch even if a fetch from the old worktree
	// arrived during the switch (removeQueries would leave that stale data).
	setOnWorktreeSwitched(() => {
		for (const key of WORKTREE_DEPENDENT_QUERY_KEYS) {
			queryClient.invalidateQueries({ queryKey: [key] });
		}
	});

	return queryClient;
}
