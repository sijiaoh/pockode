import type { ContentPart } from "../types/message";
import { splitNativePath } from "../utils/path";

/**
 * Pockode's own page tools, by both names each arrives under: Claude passes
 * `mcp__server__tool` through, Codex's adapter joins `server:tool`.
 */
type PageTool = "html_render" | "html_edit" | "html_get";

function pageTool(toolName: string): PageTool | null {
	const tool = toolName.startsWith("mcp__pockode__")
		? toolName.slice("mcp__pockode__".length)
		: toolName.startsWith("pockode:")
			? toolName.slice("pockode:".length)
			: null;
	return tool === "html_render" || tool === "html_edit" || tool === "html_get"
		? tool
		: null;
}

export function isHtmlRenderTool(toolName: string): boolean {
	return pageTool(toolName) === "html_render";
}

/** Draws a new page from an earlier one; its input holds edits, not the page. */
export function isHtmlEditTool(toolName: string): boolean {
	return pageTool(toolName) === "html_edit";
}

/** Reads a page back for the agent; it draws nothing. */
export function isHtmlGetTool(toolName: string): boolean {
	return pageTool(toolName) === "html_get";
}

/**
 * Whether the part is drawn as an HTML card rather than a row. Only once it
 * has succeeded: running, failed or cut short it is a call like any other, and
 * a page that never arrived is no part of the reply. An `html_edit` needs the
 * id of the page it stored as well, since that id is the only way to its page;
 * an `html_render` carries its page in its input, so one from before pages had
 * ids is still a card.
 */
export function isHtmlRenderCard(part: ContentPart): boolean {
	if (part.type !== "tool_call" || part.tool.status !== "success") return false;
	const tool = pageTool(part.tool.name);
	return (
		tool === "html_render" || (tool === "html_edit" && !!part.tool.htmlPage)
	);
}

function asRecord(input: unknown): Record<string, unknown> {
	return (input && typeof input === "object" ? input : {}) as Record<
		string,
		unknown
	>;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export interface HtmlRenderInput {
	title: string;
	html: string;
}

export function htmlRenderInput(input: unknown): HtmlRenderInput {
	const obj = asRecord(input);
	return { title: str(obj.title), html: str(obj.html) };
}

export interface HtmlEditInput {
	/** The page the edits apply to. */
	base: string;
	/** The new page's title; empty keeps the base's. */
	title: string;
}

export function htmlEditInput(input: unknown): HtmlEditInput {
	const obj = asRecord(input);
	return { base: str(obj.base), title: str(obj.title) };
}

export function htmlGetInput(input: unknown): { id: string } {
	return { id: str(asRecord(input).id) };
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
