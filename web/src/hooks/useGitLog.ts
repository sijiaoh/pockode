import { useQuery } from "@tanstack/react-query";
import { useIsGitRepo } from "../lib/worktreeStore";
import { useWSStore } from "../lib/wsStore";
import { gitLogQueryKey } from "./gitQueries";

export function useGitLog() {
	const getLog = useWSStore((state) => state.actions.getLog);
	const isGitRepo = useIsGitRepo();

	return useQuery({
		queryKey: gitLogQueryKey,
		queryFn: () => getLog(50),
		enabled: isGitRepo === true,
		staleTime: 30_000, // 30 seconds - commits change less frequently
	});
}
