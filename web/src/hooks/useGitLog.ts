import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useWSStore } from "../lib/wsStore";

export const gitLogQueryKey = ["git-log"] as const;

export function useGitLog() {
	const queryClient = useQueryClient();
	const getLog = useWSStore((state) => state.actions.getLog);

	const query = useQuery({
		queryKey: gitLogQueryKey,
		queryFn: () => getLog(50),
		staleTime: 30_000, // 30 seconds - commits change less frequently
	});

	const refresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: gitLogQueryKey });
	}, [queryClient]);

	return { ...query, refresh };
}
