export type EntryType = "file" | "dir";
/**
 * `none` means the server sent no content; `omitted` says why. `http` means
 * the content is a raster image whose bytes are read over HTTP from wherever
 * the description came from (`ImageOrigin`): kept off the WebSocket so one
 * picture cannot hold up every other message behind it.
 */
export type Encoding = "text" | "http" | "none";
/**
 * Why a response carries no content. Shared with the content blocks an agent
 * produces (`FileBlock.omitted`), which is the same statement about the same
 * kind of thing — one vocabulary rather than two that drift.
 */
export type OmitReason = "too_large" | "binary" | "unavailable" | "not_fetched";

export interface Entry {
	name: string;
	type: EntryType;
	path: string;
}

export interface FileContent {
	name: string;
	type: "file";
	path: string;
	size: number;
	/** Detected from the file's bytes, not its extension. Always present. */
	mime: string;
	/** Empty unless `encoding` is `text`. */
	content: string;
	encoding: Encoding;
	omitted?: OmitReason;
	/** Size ceiling that kept the content out; only sent with `too_large`. */
	limit?: number;
}

/**
 * Where a `FileContent` with `encoding: "http"` came from, which is also where
 * its bytes are read: the server sends no URL, so the reader names the same
 * thing over HTTP that it asked about over the WebSocket.
 */
export type ImageOrigin =
	/** A file in the work directory, as `file.get` describes it. */
	| { kind: "file"; path: string }
	/** A file as a commit left it, as `git.show.file` describes it. */
	| { kind: "commit"; hash: string; path: string }
	/**
	 * Content a chat event references, as `attachment.get` or — for a
	 * transcript read from outside its worktree — `session_view.attachment`
	 * describes it. `worktree` is the one it was described from, fixed then:
	 * the session lives there, and a read that starts after a worktree switch
	 * must not go looking for it in the new one.
	 */
	| { kind: "attachment"; sessionId: string; id: string; worktree: string };

export type ContentsResponse = Entry[] | FileContent;

export function isFileContent(
	response: ContentsResponse,
): response is FileContent {
	return !Array.isArray(response) && response.type === "file";
}
