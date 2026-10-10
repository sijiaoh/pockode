import type { ContentPart } from "../types/message";

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
