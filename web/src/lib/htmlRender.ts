import type { ContentPart } from "../types/message";
import { splitNativePath } from "../utils/path";

/**
 * Pockode's own `html_render` MCP tool, by both names it arrives under: Claude
 * passes `mcp__server__tool` through, Codex's adapter joins `server:tool`.
 */
export function isHtmlRenderTool(toolName: string): boolean {
	return (
		toolName === "mcp__pockode__html_render" ||
		toolName === "pockode:html_render"
	);
}

/**
 * Whether the part is drawn as an HTML card rather than a row. Only once it
 * has succeeded: running, failed or cut short it is a call like any other, and
 * a page that never arrived is no part of the reply.
 */
export function isHtmlRenderCard(part: ContentPart): boolean {
	return (
		part.type === "tool_call" &&
		part.tool.status === "success" &&
		isHtmlRenderTool(part.tool.name)
	);
}

export interface HtmlRenderInput {
	title: string;
	html: string;
}

export function htmlRenderInput(input: unknown): HtmlRenderInput {
	const obj = (input && typeof input === "object" ? input : {}) as Record<
		string,
		unknown
	>;
	return {
		title: typeof obj.title === "string" ? obj.title : "",
		html: typeof obj.html === "string" ? obj.html : "",
	};
}

/** A Windows drive, the first segment of an absolute path there. */
const DRIVE = /^[a-z]:$/i;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where a URL starts that the browser loads by itself: an attribute that
 * names one, or a CSS `url()`, quoted or not.
 */
const URL_START = String.raw`(\s(?:src|href|poster|data|srcset|xlink:href)\s*=\s*["']?|url\(\s*["']?)`;

/**
 * `html` with each absolute path into `workDir` made relative to it, so that
 * against the root of the worktree, which a page is drawn under
 * (`HtmlFrame`), it names the file it means: agents write the full path they
 * saved a file to. Only right after a URL attribute's `=` or a CSS `url(` —
 * bare or as a `file:` URL, with either separator — wherever that text stands;
 * a path anywhere else, in prose or as a script's own string, is left as
 * written, since a script cannot be told from text. Windows paths compare
 * without case, as the file system does.
 */
export function projectRelativeHtml(html: string, workDir: string): string {
	const parts = splitNativePath(workDir);
	if (parts.length === 0) return html;
	const windows = DRIVE.test(parts[0]);
	const lead = windows ? "(?:file:///?|/)?" : "(?:file://)?/";
	const dir = parts.map(escapeRegExp).join("[/\\\\]");
	// Attribute names are matched without case; a Unix path is then held to
	// its own.
	const prefix = new RegExp(`${URL_START}${lead}(${dir})[/\\\\]`, "gi");
	const exact = parts.join("/");
	return html.replace(prefix, (match, start: string, path: string) =>
		windows || splitNativePath(path).join("/") === exact ? start : match,
	);
}
