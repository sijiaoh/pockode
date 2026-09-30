import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { buildNavigation } from "../lib/navigation";
import { fetchWorktrees, WORKTREES_QUERY_KEY } from "../lib/worktreeQuery";
import {
	getDisplayName,
	useWorktreeStore,
	worktreeActions,
} from "../lib/worktreeStore";
import {
	setWorktreeDeletedListener,
	setWorktreeNotFoundListener,
	useWSStore,
	wsActions,
} from "../lib/wsStore";
import type {
	SetupHookSkip,
	WorktreeChangedNotification,
	WorktreeInfo,
	WorktreeSubscribeResult,
} from "../types/message";
import { useSubscription } from "./useSubscription";

/** Resolves to the skipped setup script, or null when it ran. */
async function createWorktree(params: {
	name: string;
	branch: string;
	baseBranch?: string;
}): Promise<SetupHookSkip | null> {
	const result = await wsActions.createWorktree(
		params.name,
		params.branch,
		params.baseBranch,
	);
	return result.setup_hook_skip ?? null;
}

async function deleteWorktree(params: { name: string }): Promise<void> {
	return wsActions.deleteWorktree(params.name);
}

export interface UseWorktreeOptions {
	enabled?: boolean;
	onDeleted?: (name: string) => void;
}

export function useWorktree({
	enabled = true,
	onDeleted,
}: UseWorktreeOptions = {}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const worktreeSubscribe = useWSStore((s) => s.actions.worktreeSubscribe);
	const worktreeUnsubscribe = useWSStore((s) => s.actions.worktreeUnsubscribe);
	const wsStatus = useWSStore((state) => state.status);
	const current = useWorktreeStore((state) => state.current);
	const isGitRepo = useWorktreeStore((state) => state.isGitRepo);
	const setupHookSkip = useWorktreeStore((state) => state.setupHookSkip);

	const isConnected = wsStatus === "connected";
	const hasConnectedOnceRef = useRef(false);

	useEffect(() => {
		if (isConnected) {
			if (hasConnectedOnceRef.current) {
				queryClient.invalidateQueries({ queryKey: WORKTREES_QUERY_KEY });
			}
			hasConnectedOnceRef.current = true;
		}
	}, [isConnected, queryClient]);

	const {
		data: worktrees = [],
		isLoading,
		isSuccess,
		error,
	} = useQuery({
		queryKey: WORKTREES_QUERY_KEY,
		queryFn: fetchWorktrees,
		enabled: enabled && isConnected,
		staleTime: Number.POSITIVE_INFINITY,
	});

	// Both answers are fresher than a list request already in flight, whose
	// reply would put the older is_git_repo back (fetchWorktrees drops the
	// writes of a cancelled one). Cancelled explicitly: invalidation alone
	// leaves a first fetch running, since there is no data yet to fall back on.
	const refetchWorktrees = useCallback(async () => {
		await queryClient.cancelQueries({ queryKey: WORKTREES_QUERY_KEY });
		await queryClient.invalidateQueries({ queryKey: WORKTREES_QUERY_KEY });
	}, [queryClient]);

	const handleWorktreeChanged = useCallback(
		({ is_git_repo }: WorktreeChangedNotification) => {
			worktreeActions.setIsGitRepo(is_git_repo);
			void refetchWorktrees();
		},
		[refetchWorktrees],
	);

	const handleWorktreeSubscribed = useCallback(
		({ is_git_repo }: WorktreeSubscribeResult) => {
			worktreeActions.setIsGitRepo(is_git_repo);
			void refetchWorktrees();
		},
		[refetchWorktrees],
	);

	// Subscribed whether or not the project is a git repository: this is the
	// subscription that reports a `git init` (or a deleted `.git`).
	useSubscription(
		worktreeSubscribe,
		worktreeUnsubscribe,
		handleWorktreeChanged,
		{
			enabled,
			// Worktree list subscription is Manager-level, not worktree-scoped
			resubscribeOnWorktreeChange: false,
			onSubscribed: handleWorktreeSubscribed,
		},
	);

	useEffect(() => {
		setWorktreeDeletedListener((name, wasCurrentWorktree) => {
			queryClient.invalidateQueries({ queryKey: WORKTREES_QUERY_KEY });
			if (wasCurrentWorktree) {
				navigate(
					buildNavigation({ type: "home", worktree: "" }, { replace: true }),
				);
			}
			onDeleted?.(name);
		});
		return () => setWorktreeDeletedListener(null);
	}, [onDeleted, queryClient, navigate]);

	useEffect(() => {
		setWorktreeNotFoundListener(() => {
			navigate(
				buildNavigation({ type: "home", worktree: "" }, { replace: true }),
			);
		});
		return () => setWorktreeNotFoundListener(null);
	}, [navigate]);

	const refresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: WORKTREES_QUERY_KEY });
	}, [queryClient]);

	const createMutation = useMutation({
		mutationFn: createWorktree,
		onSuccess: (_, { name, branch }) => {
			queryClient.setQueryData<WorktreeInfo[]>(
				WORKTREES_QUERY_KEY,
				(old = []) => {
					if (old.some((w) => w.name === name)) return old;
					return [...old, { name, branch, path: "", is_main: false }];
				},
			);
		},
	});

	const create = useCallback(
		(name: string, branch: string, baseBranch?: string) =>
			createMutation.mutateAsync({ name, branch, baseBranch }),
		[createMutation],
	);

	const deleteMutation = useMutation({
		mutationFn: deleteWorktree,
		onSuccess: (_, { name }) => {
			queryClient.setQueryData<WorktreeInfo[]>(
				WORKTREES_QUERY_KEY,
				(old = []) => old.filter((w) => w.name !== name),
			);
			if (worktreeActions.getCurrent() === name) {
				navigate(
					buildNavigation({ type: "home", worktree: "" }, { replace: true }),
				);
			}
		},
	});

	const selectWorktree = useCallback(
		(name: string) => {
			if (name === current) return;
			// URL is source of truth; store sync and WebSocket reconnect happen via listeners
			navigate(buildNavigation({ type: "home", worktree: name }));
		},
		[current, navigate],
	);

	const currentWorktree =
		worktrees.find((w) => (current ? w.name === current : w.is_main)) ??
		worktrees.find((w) => w.is_main);

	return {
		current,
		currentWorktree,
		worktrees,
		isLoading,
		isSuccess,
		error,
		isGitRepo,
		setupHookSkip,
		refresh,
		select: selectWorktree,
		create,
		delete: (name: string) => deleteMutation.mutateAsync({ name }),
		isCreating: createMutation.isPending,
		isDeleting: deleteMutation.isPending,
		getDisplayName,
	};
}
