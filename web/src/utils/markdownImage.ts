import type { Element, ElementContent, Root } from "hast";
import { relativeToWorkDir, splitNativePath, splitPath } from "./path";

/**
 * Where a Markdown image's bytes come from, decided from its `src` alone
 * (docs/markdown-images-ui.md#where-the-bytes-come-from). `name` is the file
 * name — the last segment of the path or URL — which stands in for missing alt
 * text.
 */
export type MarkdownImageTarget =
	/** A work-directory file, by its relative path in Pockode's slash form. */
	| { kind: "workspace"; path: string; name: string }
	/** A path that leaves the work directory, which is never read. */
	| { kind: "outside"; name: string }
	| { kind: "external"; url: string; name: string }
	/** Any scheme but http(s): dropped, never handed to the DOM. */
	| { kind: "unsupported"; name: string };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** A Windows absolute path, which would otherwise read as a one-letter scheme. */
const DRIVE = /^[a-z]:[\\/]/i;

function isAbsolute(path: string): boolean {
	return path.startsWith("/") || path.startsWith("\\") || DRIVE.test(path);
}

function lastSegment(path: string): string {
	return splitNativePath(path).at(-1) ?? "";
}

function decode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

function external(url: string): MarkdownImageTarget {
	try {
		const parsed = new URL(url);
		return {
			kind: "external",
			url: parsed.href,
			name: lastSegment(decode(parsed.pathname)) || parsed.host,
		};
	} catch {
		return { kind: "unsupported", name: "" };
	}
}

/**
 * `segments` with `.` dropped and `..` applied, or null when a `..` climbs above
 * the first of them — out of the work directory.
 */
function normalize(segments: string[]): string[] | null {
	const result: string[] = [];
	for (const segment of segments) {
		if (segment === ".") continue;
		if (segment === "..") {
			if (result.length === 0) return null;
			result.pop();
		} else {
			result.push(segment);
		}
	}
	return result;
}

/**
 * `src` as written in the Markdown, resolved against `baseDir` — the
 * work-directory-relative directory the text belongs to, empty for the root,
 * null for text that lives outside the work directory, whose relative images
 * are outside it too.
 *
 * A path's `?query` and `#fragment` are dropped and its percent-escapes decoded
 * first: the Markdown parser escapes a space in `<my shot.png>`, and the file is
 * still called `my shot.png`.
 */
export function resolveMarkdownImage(
	src: string,
	baseDir: string | null,
	workDir: string,
): MarkdownImageTarget {
	const raw = src.trim();
	if (raw.startsWith("//")) return external(`https:${raw}`);
	const scheme = DRIVE.test(raw) ? undefined : SCHEME.exec(raw)?.[1];
	if (scheme) {
		const lower = scheme.toLowerCase();
		return lower === "http" || lower === "https"
			? external(raw)
			: { kind: "unsupported", name: "" };
	}

	const path = decode(raw.replace(/[?#][\s\S]*$/, ""));
	const name = lastSegment(path);
	if (isAbsolute(path)) {
		const relative = relativeToWorkDir(path, workDir);
		const segments = relative === null ? null : normalize(relative.split("/"));
		return segments?.length
			? { kind: "workspace", path: segments.join("/"), name }
			: { kind: "outside", name };
	}

	if (path === "") return { kind: "unsupported", name: "" };
	if (baseDir === null) return { kind: "outside", name };
	const segments = normalize([
		...splitNativePath(baseDir),
		...splitNativePath(path),
	]);
	// Nothing left is the work directory itself, which is not a file.
	return segments?.length
		? { kind: "workspace", path: segments.join("/"), name }
		: { kind: "outside", name };
}

/**
 * The base directory for Markdown read from the file at `filePath`: the file's
 * own directory, as a README's images are written relative to it.
 *
 * `filePath` is either a work-directory-relative path (Files) or a tool call's
 * native path (the transcript), which is absolute and may lie outside the work
 * directory — null then, see `resolveMarkdownImage`.
 */
export function markdownFileBaseDir(
	filePath: string,
	workDir: string,
): string | null {
	const relative = isAbsolute(filePath)
		? relativeToWorkDir(filePath, workDir)
		: splitNativePath(filePath).join("/");
	return relative === null ? null : splitPath(relative).directory;
}

/** Set on an image alone on its line; every other image is inline. */
export const BLOCK_IMAGE_PROPERTY = "dataMarkdownImageBlock";
/** Set on an image inside a link, which a tap follows instead of opening it. */
export const LINKED_IMAGE_PROPERTY = "dataMarkdownImageLinked";

function isWhitespace(node: ElementContent): boolean {
	return node.type === "text" && node.value.trim() === "";
}

/**
 * Marks each image of `parent` that stands alone on its line. A line ends at a
 * `<br>` — which is what `remark-breaks` makes of a newline — or at a newline
 * left in the text.
 */
function markBlockImages(parent: Element): void {
	let line: ElementContent[] = [];
	const endLine = () => {
		const content = line.filter((node) => !isWhitespace(node));
		const only = content[0];
		if (
			content.length === 1 &&
			only.type === "element" &&
			only.tagName === "img"
		) {
			only.properties[BLOCK_IMAGE_PROPERTY] = true;
		}
		line = [];
	};
	for (const child of parent.children) {
		if (child.type === "element" && child.tagName === "br") {
			endLine();
		} else if (child.type === "text" && child.value.includes("\n")) {
			child.value.split("\n").forEach((part, i) => {
				if (i > 0) endLine();
				line.push({ type: "text", value: part });
			});
		} else {
			line.push(child);
		}
	}
	endLine();
}

/**
 * Drops the line break after each block image: the image is a box of its own,
 * so the next line starts below it anyway, and a `<br>` leading that line
 * would draw an empty one.
 */
function dropBreaksAfterBlockImages(parent: Element): void {
	let afterBlock = false;
	parent.children = parent.children.filter((child) => {
		if (afterBlock && child.type === "element" && child.tagName === "br") {
			afterBlock = false;
			return false;
		}
		if (!isWhitespace(child)) {
			afterBlock =
				child.type === "element" &&
				child.tagName === "img" &&
				child.properties[BLOCK_IMAGE_PROPERTY] === true;
		}
		return true;
	});
}

function walk(parent: Root | Element, inLink: boolean): void {
	for (const child of parent.children) {
		if (child.type !== "element") continue;
		const linked = inLink || child.tagName === "a";
		if (child.tagName === "img" && linked) {
			child.properties[LINKED_IMAGE_PROPERTY] = true;
		}
		// Only paragraphs and list items: a table cell or a heading is where a
		// README puts small images, so an image there is inline even alone.
		if (child.tagName === "p" || child.tagName === "li") {
			markBlockImages(child);
			dropBreaksAfterBlockImages(child);
		}
		walk(child, linked);
	}
}

/**
 * Decides each image's shape from where it stands in the text, so it is known
 * on the first frame rather than when the bytes arrive
 * (docs/markdown-images-ui.md#block-or-inline).
 */
export function rehypeMarkdownImages() {
	return (tree: Root) => walk(tree, false);
}
