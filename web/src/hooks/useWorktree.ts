import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { buildNavigation } from "../lib/navigation";
import {
	getDisplayName,
	useWorktreeStore,
	worktreeActions,
} from "../lib/worktreeStore";
import {
	setWorktreeDeletedListener,
	useWSStore,
	wsActions,
} from "../lib/wsStore";
import type { WorktreeInfo } from "../types/message";

async function listWorktrees(): Promise<WorktreeInfo[]> {
	return wsActions.listWorktrees();
}

async function createWorktree(params: {
	name: string;
	branch: string;
}): Promise<void> {
	return wsActions.createWorktree(params.name, params.branch);
}

async function deleteWorktree(params: {
	name: string;
	force?: boolean;
}): Promise<void> {
	return wsActions.deleteWorktree(params.name, params.force);
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

	const isConnected = wsStatus === "connected";
	const hasConnectedOnceRef = useRef(false);

	useEffect(() => {
		if (isConnected) {
			if (hasConnectedOnceRef.current) {
				queryClient.invalidateQueries({ queryKey: ["worktrees"] });
			}
			hasConnectedOnceRef.current = true;
		}
	}, [isConnected, queryClient]);

	const {
		data: worktrees = [],
		isLoading,
		isSuccess,
	} = useQuery({
		queryKey: ["worktrees"],
		queryFn: listWorktrees,
		enabled: enabled && isConnected && isGitRepo,
		staleTime: Number.POSITIVE_INFINITY,
	});

	// Subscribe to worktree list changes
	useEffect(() => {
		if (!enabled || !isConnected || !isGitRepo) return;

		let watchId: string | null = null;
		let cancelled = false;

		worktreeSubscribe(() => {
			queryClient.invalidateQueries({ queryKey: ["worktrees"] });
		})
			.then((id) => {
				if (cancelled) {
					worktreeUnsubscribe(id);
				} else {
					watchId = id;
				}
			})
			.catch((err) => {
				console.error("Failed to subscribe to worktree watch:", err);
			});

		return () => {
			cancelled = true;
			if (watchId) {
				worktreeUnsubscribe(watchId);
			}
		};
	}, [
		enabled,
		isConnected,
		isGitRepo,
		queryClient,
		worktreeSubscribe,
		worktreeUnsubscribe,
	]);

	useEffect(() => {
		setWorktreeDeletedListener((name, wasCurrentWorktree) => {
			queryClient.invalidateQueries({ queryKey: ["worktrees"] });
			if (wasCurrentWorktree) {
				navigate(
					buildNavigation({ type: "home", worktree: "" }, { replace: true }),
				);
			}
			onDeleted?.(name);
		});
		return () => setWorktreeDeletedListener(null);
	}, [onDeleted, queryClient, navigate]);

	const refresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["worktrees"] });
	}, [queryClient]);

	const createMutation = useMutation({
		mutationFn: createWorktree,
		onSuccess: (_, { name, branch }) => {
			queryClient.setQueryData<WorktreeInfo[]>(["worktrees"], (old = []) => {
				if (old.some((w) => w.name === name)) return old;
				return [...old, { name, branch, path: "", is_main: false }];
			});
		},
	});

	const deleteMutation = useMutation({
		mutationFn: deleteWorktree,
		onSuccess: (_, { name }) => {
			queryClient.setQueryData<WorktreeInfo[]>(["worktrees"], (old = []) =>
				old.filter((w) => w.name !== name),
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
		isGitRepo,
		refresh,
		select: selectWorktree,
		create: (name: string, branch: string) =>
			createMutation.mutateAsync({ name, branch }),
		delete: (name: string, force?: boolean) =>
			deleteMutation.mutateAsync({ name, force }),
		isCreating: createMutation.isPending,
		isDeleting: deleteMutation.isPending,
		getDisplayName,
	};
}
