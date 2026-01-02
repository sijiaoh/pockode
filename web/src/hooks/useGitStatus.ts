import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { getGitStatus } from "../lib/gitApi";

export function useGitStatus() {
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: ["git-status"],
		queryFn: getGitStatus,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const refresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["git-status"] });
	}, [queryClient]);

	return { ...query, refresh };
}
