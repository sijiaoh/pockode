import type { FileContent, ImageOrigin } from "../types/contents";

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

/**
 * How to get an image on screen: a URL that is already here, or bytes still to
 * be read from where the description came from (`useImageSrc` turns those into
 * one).
 */
export type ImageSource =
	| { kind: "inline"; src: string }
	| { kind: "remote"; origin: ImageOrigin; mime: string };

export type FileViewState =
	| { kind: "empty" }
	| { kind: "text"; content: string; highlight: boolean }
	// `editable` is what SVG needs: it is an image the viewer renders and source
	// the user can still open in the editor.
	| {
			kind: "image";
			source: ImageSource;
			mime: string;
			size: number;
			editable: boolean;
	  }
	| { kind: "binary"; mime: string; size: number }
	| { kind: "too-large"; mime: string; size: number; limit?: number }
	// Nothing is wrong with the content — there just is none to read any more.
	// Kept apart from the two above for that reason: those say this content
	// cannot be shown, and retrying them is pointless.
	| { kind: "unavailable"; mime: string; size: number };

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

/**
 * Whether content of this type is something to render as a picture.
 *
 * One test rather than one per call site: the viewer, the chat's attachment
 * strip and the "too large" wording all have to agree on what counts, and they
 * are in three different files.
 */
export function isImageMime(mime: string): boolean {
	return getMimeType(mime).startsWith("image/");
}

/**
 * Where to get the picture for a file the server identified as an image.
 *
 * SVG is the one image that arrives as source text, and it stays a data URL
 * rather than becoming a Blob: an object URL is same-origin with this document,
 * so a script in an SVG opened through one would run as the app.
 */
export function getImageSource(
	file: FileContent,
	origin: ImageOrigin,
): ImageSource {
	if (file.encoding === "http") {
		return { kind: "remote", origin, mime: file.mime };
	}
	// Percent-encoding rather than base64 keeps the `#` in colour literals from
	// truncating the URL at a fragment.
	return {
		kind: "inline",
		src: `data:image/svg+xml,${encodeURIComponent(file.content)}`,
	};
}

/**
 * The text content the server sent, for handing to the browser as a file.
 *
 * Not `lib/fileDownload`'s `downloadFile`, which reads a file by its path over
 * HTTP: this content is already here and has no path to ask for it by. Null
 * for anything else — content sent over HTTP is read from its origin instead
 * (`fetchImageBlob`). Untyped: `saveBlob` gives every saved Blob the one type
 * that is safe to hand the browser.
 */
export function fileContentToBlob(file: FileContent): Blob | null {
	if (file.encoding !== "text") return null;
	return new Blob([file.content]);
}

/**
 * What the viewer should render for a file.
 *
 * Order is priority: a file the server declined to send has no content to
 * classify, and everything the server did send is either an image or text.
 * An image is a raster one sent as `http`, or an SVG, the one image that
 * arrives as `text`. Text under any other image type stays text: the server
 * names AVIF, HEIC and TIFF from the extension alone, so a git-LFS pointer
 * committed as `photo.avif` arrives as `text` typed `image/avif`, and drawing
 * it would only show a broken picture of something readable.
 *
 * `origin` is what the file was asked for by, which is where a raster image's
 * bytes are read from.
 */
export function getFileViewState(
	file: FileContent,
	origin: ImageOrigin,
): FileViewState {
	if (file.encoding === "none") {
		switch (file.omitted) {
			case "binary":
				return { kind: "binary", mime: file.mime, size: file.size };
			case "unavailable":
				return { kind: "unavailable", mime: file.mime, size: file.size };
			default:
				return {
					kind: "too-large",
					mime: file.mime,
					size: file.size,
					limit: file.limit,
				};
		}
	}

	if (file.size === 0) {
		return { kind: "empty" };
	}

	if (file.encoding === "http" || getMimeType(file.mime) === "image/svg+xml") {
		return {
			kind: "image",
			source: getImageSource(file, origin),
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
		case "unavailable":
			return "Edit (this file is no longer available)";
		default:
			return "Edit";
	}
}
