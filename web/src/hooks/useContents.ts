import { useQuery } from "@tanstack/react-query";
import { getContents } from "../lib/contentsApi";

export function useContents(path = "", enabled = true) {
	return useQuery({
		queryKey: ["contents", path],
		queryFn: () => getContents(path),
		enabled,
		staleTime: 0,
	});
}
