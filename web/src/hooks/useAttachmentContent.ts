import { useQuery } from "@tanstack/react-query";
import { DEFAULT_RETRY_COUNT } from "../lib/queryClient";
import { useSessionView } from "../lib/sessionView";
import { useWorktreeStore } from "../lib/worktreeStore";
import { isRPCTimeout, useWSStore } from "../lib/wsStore";
import type { AttachmentSource } from "../types/content";
import {
	type ContentOrigin,
	type ContentsResponse,
	type FileContent,
	isFileContent,
	isLinkResult,
} from "../types/contents";
import { contentsQueryKey, readContents } from "./useContents";

/**
 * Where the answer is cached.
 *
 * A path shares the Files tab's own key, so opening the file there after seeing
 * it here costs nothing. The entry holds whatever `file.get` answered for the
 * path, stored as `useContents` stores it: a block names a file, but a path the
 * agent wrote can be a directory link, or a link that cannot be followed, and
 * either may be cached there already. So it is read through `notAFile`, never
 * taken to be a `FileContent`.
 */
export function attachmentQueryKey(
	source: AttachmentSource,
	/**
	 * The worktree the bytes are read from, for a transcript being viewed from
	 * outside. Part of the key because the same session id names a different
	 * directory there — and because a path, the other branch, is always the
	 * bound worktree's.
	 */
	viewWorktree?: string,
) {
	if (source.kind !== "attachment") return contentsQueryKey(source.path);
	return viewWorktree === undefined
		? (["attachment", source.sessionId, source.id] as const)
		: (["attachment", viewWorktree, source.sessionId, source.id] as const);
}

/**
 * Where an attachment's bytes are read from over HTTP: where its
 * description came from — the transcript's own worktree when it is being read
 * from outside, otherwise the one the WebSocket is bound to now.
 */
export function useAttachmentOrigin(source: AttachmentSource): ContentOrigin {
	const view = useSessionView();
	const bound = useWorktreeStore((state) => state.current);
	return source.kind === "attachment"
		? { ...source, worktree: view?.worktree ?? bound }
		: source;
}

/**
 * What a path turned out to be when it is not a file: a folder (a directory
 * link the agent named, say) or a link that cannot be followed. Shown as a
 * chip that opens in Files, never as content (docs/symlinks.md#chat).
 */
export type NotAFile = "folder" | "link";

/**
 * Reads an attachment's description, which carries the content itself only
 * when it is text; a raster image's bytes are read separately (`useImageSrc`).
 *
 * `enabled` is how the strip keeps a history page from pulling every image it
 * scrolls past: the caller turns it on when the thumbnail comes into view. The
 * result is cached for the session's lifetime, because an attachment's bytes
 * are fixed once written — an id names content, and a replayed history record
 * names the same id every time.
 */
export function useAttachmentContent(source: AttachmentSource, enabled = true) {
	const getAttachment = useWSStore((state) => state.actions.getAttachment);
	const sessionViewAttachment = useWSStore(
		(state) => state.actions.sessionViewAttachment,
	);
	const getFile = useWSStore((state) => state.actions.getFile);
	// A transcript read out of another worktree keeps its pictures: the bytes
	// live beside the records, and `attachment.get` would look for them in the
	// bound worktree, which is not where they are. The one thing deep in the
	// message tree that has to know where it is reading from — hence a context
	// rather than a prop through every memoized row.
	const view = useSessionView();

	const query = useQuery<FileContent | ContentsResponse>({
		queryKey: attachmentQueryKey(source, view?.worktree),
		queryFn: () => {
			if (source.kind === "attachment") {
				return view
					? sessionViewAttachment(view.worktree, source.sessionId, source.id)
					: getAttachment(source.sessionId, source.id);
			}
			return readContents(getFile, source.path);
		},
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		// Same rule as `useContents`: a timeout means the read was slow, and
		// retrying makes the server re-encode and re-send the whole thing while
		// the first attempt is very likely still in flight.
		retry: (failureCount, error) =>
			!isRPCTimeout(error) && failureCount < DEFAULT_RETRY_COUNT,
	});
	// Named fields rather than a spread: a query result tracks which fields are
	// read, and spreading reads them all.
	const { data, error, refetch } = query;
	const file = data && isFileContent(data) ? data : undefined;
	const notAFile: NotAFile | null =
		data === undefined || file ? null : isLinkResult(data) ? "link" : "folder";
	return { data: file, error, refetch, notAFile };
}
