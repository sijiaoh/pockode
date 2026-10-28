import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import { gitStatusQueryKey } from "./gitQueries";

export function useGitStage() {
	const queryClient = useQueryClient();
	const stage = useWSStore((s) => s.actions.stage);
	const unstage = useWSStore((s) => s.actions.unstage);

	const stageMutation = useMutation({
		mutationFn: (paths: string[]) => stage(paths),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: gitStatusQueryKey }),
	});

	// The one stage of a conflicted path: the user marking it resolved.
	const resolveMutation = useMutation({
		mutationFn: (paths: string[]) => stage(paths, true),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: gitStatusQueryKey }),
	});

	const unstageMutation = useMutation({
		mutationFn: unstage,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: gitStatusQueryKey }),
	});

	return { stageMutation, resolveMutation, unstageMutation };
}
