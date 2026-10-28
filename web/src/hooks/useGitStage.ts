import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import { gitStatusQueryKey } from "./gitQueries";

interface HunkTarget {
	path: string;
	hunkId: string;
}

export function useGitStage() {
	const queryClient = useQueryClient();
	const stage = useWSStore((s) => s.actions.stage);
	const unstage = useWSStore((s) => s.actions.unstage);
	const stageHunk = useWSStore((s) => s.actions.stageHunk);
	const unstageHunk = useWSStore((s) => s.actions.unstageHunk);
	const invalidateStatus = () =>
		queryClient.invalidateQueries({ queryKey: gitStatusQueryKey });

	const stageMutation = useMutation({
		mutationFn: stage,
		onSuccess: invalidateStatus,
	});

	const unstageMutation = useMutation({
		mutationFn: unstage,
		onSuccess: invalidateStatus,
	});

	const stageHunkMutation = useMutation({
		mutationFn: ({ path, hunkId }: HunkTarget) => stageHunk(path, hunkId),
		onSuccess: invalidateStatus,
	});

	const unstageHunkMutation = useMutation({
		mutationFn: ({ path, hunkId }: HunkTarget) => unstageHunk(path, hunkId),
		onSuccess: invalidateStatus,
	});

	return {
		stageMutation,
		unstageMutation,
		stageHunkMutation,
		unstageHunkMutation,
	};
}
