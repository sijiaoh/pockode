import type { AttachmentSource, FileBlock } from "../types/content";
import type { OmitReason } from "../types/contents";
import { formatBytes } from "./bytes";
import { formatMimeLabel, isImageMime } from "./fileView";
import { relativeToWorkDir, splitNativePath } from "./path";

export function isImageBlock(file: FileBlock): boolean {
	return isImageMime(file.mime);
}

/**
 * Whether to try drawing the block as a picture.
 *
 * `isImageBlock` asks what the agent called the content; this asks what is
 * worth attempting. A block reporting no type at all is included because the
 * server stores an image whose media type went missing — the CLI's block type
 * is what asserts it is one — and dropping it here would make that storing
 * pointless. Nothing is risked by trying: the fetch types the content from its
 * own bytes, so content that turns out not to be an image falls back to exactly
 * the entry it would have been given without asking.
 */
export function previewsAsImage(file: FileBlock): boolean {
	return file.mime === "" || isImageBlock(file);
}

/**
 * The file the block names, as a path the Files tab can open — null when it
 * names none, or one outside the work directory.
 *
 * Kept apart from `attachmentSource`: an agent can both hand over the content
 * and say where it came from (Codex does), and then the bytes are read from the
 * attachment store while the way over is still this path.
 */
export function workspacePath(file: FileBlock, workDir: string): string | null {
	return file.path ? relativeToWorkDir(file.path, workDir) : null;
}

/**
 * Where to read a block's bytes, or null when there are none to read.
 *
 * The stored content is the first route and the usual one. The file itself is
 * the second, and it is what makes `unavailable` recoverable: that reason means
 * the server could not keep or read the content, not that anything is wrong
 * with it, so a file still sitting in the work directory can be read the way
 * the Files tab reads it and the image appears after all.
 *
 * `too_large` and `binary` get no second route. Both are statements about the
 * content itself, and reading the file would only have the server repeat them
 * — the same ceiling, the same refusal — after a round trip spent finding out.
 *
 * A block that only names a path outside the work directory is one of the
 * nulls: every route into a file takes a work-directory-relative path, so there
 * is nothing to ask with. The block is still shown — it says what the agent
 * produced, and the path is the useful half of that.
 */
export function attachmentSource(
	file: FileBlock,
	sessionId: string,
	workDir: string,
): AttachmentSource | null {
	// `not_fetched` joins the two content statements here rather than with
	// `unavailable`: the server chose not to push the bytes into the transcript,
	// and fetching them behind the user's back is exactly that choice reversed.
	// The path stays, which is how the file is still reachable.
	if (file.omitted && file.omitted !== "unavailable") return null;
	if (file.attachment_id) {
		return { kind: "attachment", sessionId, id: file.attachment_id };
	}
	const relative = workspacePath(file, workDir);
	return relative === null ? null : { kind: "file", path: relative };
}

/** The file this block names, when it names one. */
function namedFile(file: FileBlock): string | null {
	if (file.name) return file.name;
	if (file.path) {
		const parts = splitNativePath(file.path);
		if (parts.length > 0) return parts[parts.length - 1];
	}
	return null;
}

function imageOrFile(file: FileBlock): string {
	return isImageBlock(file) ? "image" : "file";
}

/**
 * What to call the block on screen.
 *
 * An agent that hands over content inline names nothing — there is no file to
 * name — so the type stands in, phrased as a description rather than as a file
 * name: it would be a lie to show "image.png" for something that was never a
 * file on disk. Saving it does need a name, which is `attachmentFileName`.
 */
export function attachmentName(file: FileBlock): string {
	const named = namedFile(file);
	if (named) return named;
	if (file.mime) return `${formatMimeLabel(file.mime)} ${imageOrFile(file)}`;
	return "File";
}

/**
 * What to save the block as.
 *
 * The extension is the point: a download named after the label — "PNG image",
 * with no extension — reaches the disk as something neither the OS nor the
 * user can open. It comes from the type the block reports, which is what the
 * agent encoded the content as and so the only description of it there is.
 */
export function attachmentFileName(file: FileBlock): string {
	const named = namedFile(file);
	if (named) return named;
	const stem = imageOrFile(file);
	if (!file.mime) return stem;
	return `${stem}.${formatMimeLabel(file.mime).toLowerCase()}`;
}

/** The one-line description under the name: `PNG · 2000×1333 · 433 KB`. */
export function attachmentDetail(file: FileBlock): string {
	return [
		file.mime ? formatMimeLabel(file.mime) : null,
		file.width && file.height ? `${file.width}×${file.height}` : null,
		file.size ? formatBytes(file.size) : null,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * Why a block carries no content, in the few words a strip entry has room for.
 * The full wording belongs to the cards in `FileBody`, which is what the reader
 * gets on anything they can open.
 */
export function omittedLabel(file: { omitted?: OmitReason }): string | null {
	switch (file.omitted) {
		case "too_large":
			return "Too large to preview";
		case "binary":
			return "Can't be previewed";
		case "unavailable":
			return "Not available";
		// Deliberately not read, rather than unreadable: a background task's log
		// can be arbitrarily large, and the path beside it is how to reach it.
		//
		// The sentence stops at the statement and does not tell the reader to
		// open it. A CLI writes a background log wherever it likes, which is
		// often outside the work directory, and every route into a file takes a
		// work-directory-relative path — so there is no Open beside a good half
		// of these. The strip draws that button when there is one to draw.
		case "not_fetched":
			return "Not fetched";
		default:
			return null;
	}
}
