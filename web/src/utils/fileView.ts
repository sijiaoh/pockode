import type { FileContent } from "../types/contents";

/**
 * Byte ceiling above which file content is shown without syntax highlighting.
 *
 * Shiki tokenizes synchronously on the main thread at roughly 3 ms/KiB on a
 * desktop and several times that on a phone, so highlighting a file anywhere
 * near the server's 2 MiB transfer limit freezes the UI for seconds.
 */
export const HIGHLIGHT_LIMIT = 256 * 1024;

/**
 * The same idea for the editor, where the ceiling has to be far lower.
 *
 * `react-simple-code-editor` re-highlights the entire document on every
 * keystroke, so the viewer's one-off cost becomes a per-character one: 256 KiB
 * would put roughly a second between pressing a key and seeing it, and several
 * on a phone. Measured at ~190 ms for 32 KiB on a desktop, this is about as
 * large as the document can get while typing still tracks the keyboard.
 *
 * Past it the file stays editable and only loses its colours.
 */
export const EDITOR_HIGHLIGHT_LIMIT = 32 * 1024;

export type FileViewState =
	| { kind: "empty" }
	| { kind: "text"; content: string; highlight: boolean }
	// `editable` is what SVG needs: it is an image the viewer renders and source
	// the user can still open in the editor.
	| {
			kind: "image";
			src: string;
			mime: string;
			size: number;
			editable: boolean;
	  }
	| { kind: "binary"; mime: string; size: number }
	| { kind: "too-large"; mime: string; size: number; limit?: number };

/** MIME without its parameters: `text/plain; charset=utf-8` -> `text/plain`. */
export function getMimeType(mime: string): string {
	return mime.split(";")[0].trim();
}

/**
 * Short badge for a MIME type: `image/svg+xml` -> `SVG`, `image/x-icon` ->
 * `ICON`. Taking the subtype verbatim would surface registry noise like the
 * `x-` prefix and `+xml` suffix that says nothing about the file.
 */
export function formatMimeLabel(mime: string): string {
	const type = getMimeType(mime);
	const subtype = type.split("/")[1];
	if (!subtype) return type.toUpperCase();

	const name = subtype.split("+")[0].split(".").pop() ?? subtype;
	return name.replace(/^x-/, "").toUpperCase();
}

/** Data URL for a file the server identified as an image. */
export function getImageSrc(file: FileContent): string {
	if (file.encoding === "base64") {
		return `data:${getMimeType(file.mime)};base64,${file.content}`;
	}
	// SVG arrives as source text. Percent-encoding rather than base64 keeps the
	// `#` in colour literals from truncating the URL at a fragment.
	return `data:image/svg+xml,${encodeURIComponent(file.content)}`;
}

/**
 * What the viewer should render for a file.
 *
 * Order is priority: a file the server declined to send has no content to
 * classify, and everything the server did send is either an image or text.
 * SVG lands in `image` while still arriving as `text`, which is why the image
 * test is on `mime` rather than on `encoding`.
 */
export function getFileViewState(file: FileContent): FileViewState {
	if (file.encoding === "none") {
		return file.omitted === "binary"
			? { kind: "binary", mime: file.mime, size: file.size }
			: {
					kind: "too-large",
					mime: file.mime,
					size: file.size,
					limit: file.limit,
				};
	}

	if (file.size === 0) {
		return { kind: "empty" };
	}

	if (getMimeType(file.mime).startsWith("image/")) {
		return {
			kind: "image",
			src: getImageSrc(file),
			mime: file.mime,
			size: file.size,
			// Only SVG arrives as text, and text is exactly what the editor can
			// open — so the one image with source keeps its source.
			editable: file.encoding === "text",
		};
	}

	// Sized from the server's byte count, not `content.length`: the latter counts
	// UTF-16 code units, so a file of CJK text would look half its real weight.
	return {
		kind: "text",
		content: file.content,
		highlight: file.size <= HIGHLIGHT_LIMIT,
	};
}

export function canEditFileView(state: FileViewState): boolean {
	switch (state.kind) {
		case "text":
		case "empty":
			return true;
		case "image":
			return state.editable;
		default:
			return false;
	}
}

/**
 * Accessible name for the Edit button. Disabling it silently would read as the
 * feature having vanished, so the reason travels with the control.
 */
export function getEditLabel(state: FileViewState): string {
	if (canEditFileView(state)) return "Edit";

	switch (state.kind) {
		case "image":
			return "Edit (images can't be edited)";
		case "binary":
			return "Edit (binary files can't be edited)";
		case "too-large":
			return "Edit (file is too large to edit)";
		default:
			return "Edit";
	}
}
