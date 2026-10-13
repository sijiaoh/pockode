import type { ContentOrigin, FileContent } from "../types/contents";
import { formatBytes } from "./bytes";

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
	| { kind: "remote"; origin: ContentOrigin; mime: string };

export type PlayableKind = "audio" | "video";

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
	// Read over HTTP from `origin` (a player streams it through a raw
	// capability), at any size: unlike an image it is never held whole.
	| {
			kind: PlayableKind;
			origin: ContentOrigin;
			mime: string;
			size: number;
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
 * Types whose subtype is not the name people know the format by: an iPhone
 * recording is a MOV, not a QUICKTIME.
 */
const MEDIA_LABELS = new Map([
	["video/quicktime", "MOV"],
	["audio/mpeg", "MP3"],
	["audio/mp4", "M4A"],
	["audio/wave", "WAV"],
]);

/**
 * Short badge for a MIME type: `image/svg+xml` -> `SVG`, `image/x-icon` ->
 * `ICON`. Taking the subtype verbatim would surface registry noise like the
 * `x-` prefix and `+xml` suffix that says nothing about the file.
 */
export function formatMimeLabel(mime: string): string {
	const type = getMimeType(mime);
	const known = MEDIA_LABELS.get(type);
	if (known) return known;
	const subtype = type.split("/")[1];
	if (!subtype) return type.toUpperCase();

	const name = subtype.split("+")[0].split(".").pop() ?? subtype;
	return name.replace(/^x-/, "").toUpperCase();
}

export interface ImageDimensions {
	width: number;
	height: number;
}

/**
 * The one line said under media wherever it is shown — the in-place preview
 * and the full-screen viewer — e.g. `PNG · 2000×1333 · 433 KB`,
 * `MOV · 1080×1920 · 0:42 · 38.2 MB`, `MP3 · 3:12 · 4.1 MB`.
 */
export function formatMediaCaption(
	mime: string,
	size: number,
	{
		dimensions,
		duration,
	}: {
		dimensions?: ImageDimensions | null;
		/** Seconds. Left out unless finite: a MediaRecorder `.webm` reports `Infinity`. */
		duration?: number | null;
	} = {},
): string {
	return [
		formatMimeLabel(mime),
		dimensions && `${dimensions.width}×${dimensions.height}`,
		duration != null && Number.isFinite(duration) && formatDuration(duration),
		formatBytes(size),
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * The box an inline video is shown in: its own shape, contained within the
 * frame and 70vh and never enlarged, as an image is. Until its metadata says
 * what that shape is, a 16:9 box — the shape of a screen recording or a
 * landscape phone clip — so the page does not jump from nothing to a video.
 * A wrapper's size rather than `<video width height>`, whose mapping before
 * the video's own size is known differs between browsers.
 */
export function inlineVideoBox(dimensions: ImageDimensions | null): {
	aspectRatio: string;
	width: string;
} {
	const { width, height } = dimensions ?? { width: 16, height: 9 };
	const fit = `calc(70vh * ${width} / ${height})`;
	return {
		aspectRatio: `${width} / ${height}`,
		width: dimensions ? `min(100%, ${width}px, ${fit})` : `min(100%, ${fit})`,
	};
}

/** `m:ss`, or `h:mm:ss` from an hour: `42` -> `0:42`, `3725` -> `1:02:05`. */
export function formatDuration(seconds: number): string {
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
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
 * Whether content of this type is played rather than drawn or read, and by
 * which element. The counterpart of the server's `IsPlayableMIME`: together
 * with raster images, this is what the server sends as `http` with no size
 * ceiling, so the two have to agree on what counts.
 */
export function getPlayableKind(mime: string): PlayableKind | null {
	const type = getMimeType(mime);
	if (type.startsWith("audio/")) return "audio";
	if (type.startsWith("video/")) return "video";
	return null;
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
	origin: ContentOrigin,
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
 * What the viewer should render for a file.
 *
 * Order is priority: a file the server declined to send has no content to
 * classify, and everything the server did send is media or text. Media sent as
 * `http` is audio, video or a raster image, told apart by its type; the other
 * image is an SVG, the one that arrives as `text`. Text under any other media
 * type stays text: the server names AVIF, HEIC, TIFF and `.mov` from the
 * extension alone, so a git-LFS pointer committed as `photo.avif` arrives as
 * `text` typed `image/avif`, and drawing it would only show a broken picture of
 * something readable.
 *
 * `origin` is what the file was asked for by, which is where media bytes are
 * read from.
 */
export function getFileViewState(
	file: FileContent,
	origin: ContentOrigin,
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

	const playable = file.encoding === "http" ? getPlayableKind(file.mime) : null;
	if (playable) {
		return { kind: playable, origin, mime: file.mime, size: file.size };
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
		case "audio":
		case "video":
			return `Edit (${state.kind} files can't be edited)`;
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
