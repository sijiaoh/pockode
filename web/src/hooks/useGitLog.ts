import { useQuery } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import { gitLogQueryKey } from "./gitQueries";

export function useGitLog() {
	const getLog = useWSStore((state) => state.actions.getLog);

	return useQuery({
		queryKey: gitLogQueryKey,
		queryFn: () => getLog(50),
		staleTime: 30_000, // 30 seconds - commits change less frequently
	});
}
