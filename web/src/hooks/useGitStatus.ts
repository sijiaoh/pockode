import { useQuery } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import { gitStatusQueryKey } from "./gitQueries";

export function useGitStatus() {
	const getStatus = useWSStore((state) => state.actions.getStatus);

	return useQuery({
		queryKey: gitStatusQueryKey,
		queryFn: getStatus,
		staleTime: Number.POSITIVE_INFINITY,
	});
}
