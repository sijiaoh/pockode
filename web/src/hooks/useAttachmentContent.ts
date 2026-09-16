import { useQuery } from "@tanstack/react-query";
import { DEFAULT_RETRY_COUNT } from "../lib/queryClient";
import { isRPCTimeout, useWSStore } from "../lib/wsStore";
import type { AttachmentSource } from "../types/content";
import type { FileContent } from "../types/contents";
import { contentsQueryKey } from "./useContents";

/**
 * Where the answer is cached.
 *
 * A path shares the Files tab's own key, so opening the file there after seeing
 * it here costs nothing. That is safe because a path names a file or a
 * directory and never both, and the blocks that reach here always name a file —
 * so the entry the two hooks share only ever holds a `FileContent`.
 */
export function attachmentQueryKey(source: AttachmentSource) {
	return source.kind === "attachment"
		? (["attachment", source.sessionId, source.id] as const)
		: contentsQueryKey(source.path);
}

/**
 * Reads an attachment's content.
 *
 * `enabled` is how the strip keeps a history page from pulling every image it
 * scrolls past: the caller turns it on when the thumbnail comes into view. The
 * result is cached for the session's lifetime, because an attachment's bytes
 * are fixed once written — an id names content, and a replayed history record
 * names the same id every time.
 */
export function useAttachmentContent(source: AttachmentSource, enabled = true) {
	const getAttachment = useWSStore((state) => state.actions.getAttachment);
	const getFile = useWSStore((state) => state.actions.getFile);

	return useQuery<FileContent>({
		queryKey: attachmentQueryKey(source),
		queryFn: async () => {
			if (source.kind === "attachment") {
				return getAttachment(source.sessionId, source.id);
			}
			const result = await getFile(source.path);
			// Only a directory answers without one, and a block never names a
			// directory — so this says what happened rather than "not found",
			// which would send the reader looking for a file that is right there.
			if (!result.file) throw new Error(`not a file: ${source.path}`);
			return result.file;
		},
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		// Same rule as `useContents`: a timeout means the read was slow, and
		// retrying makes the server re-encode and re-send the whole thing while
		// the first attempt is very likely still in flight.
		retry: (failureCount, error) =>
			!isRPCTimeout(error) && failureCount < DEFAULT_RETRY_COUNT,
	});
}
