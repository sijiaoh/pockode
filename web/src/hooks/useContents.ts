import { useQuery } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import type { Entry, FileContent } from "../types/contents";

type ContentsResponse = Entry[] | FileContent;

export const contentsQueryKey = (path: string) => ["contents", path] as const;

export function useContents(path = "", enabled = true) {
	const getFile = useWSStore((state) => state.actions.getFile);

	return useQuery<ContentsResponse>({
		queryKey: contentsQueryKey(path),
		queryFn: async () => {
			const result = await getFile(path);
			if (result.type === "directory") {
				return result.entries ?? [];
			}
			return result.file as FileContent;
		},
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
	});
}
