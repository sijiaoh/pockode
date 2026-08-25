export type EntryType = "file" | "dir";
/** `none` means the server sent no content; `omitted` says why. */
export type Encoding = "text" | "base64" | "none";
export type OmitReason = "too_large" | "binary";

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
	/** Empty when `encoding` is `none`. */
	content: string;
	encoding: Encoding;
	omitted?: OmitReason;
	/** Size ceiling that kept the content out; only sent with `too_large`. */
	limit?: number;
}

export type ContentsResponse = Entry[] | FileContent;

export function isFileContent(
	response: ContentsResponse,
): response is FileContent {
	return !Array.isArray(response) && response.type === "file";
}
