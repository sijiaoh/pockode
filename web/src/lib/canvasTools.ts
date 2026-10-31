/**
 * The two canvas tools (docs/canvas-ui.md §3), by both names each arrives
 * under: Claude passes `mcp__server__tool` through, Codex's adapter joins
 * `server:tool`. The server's `canvas.IsTool` is the same list.
 */
const CANVAS_RENDER_NAMES = [
	"mcp__pockode__canvas_render",
	"pockode:canvas_render",
];
const CANVAS_UPDATE_NAMES = [
	"mcp__pockode__canvas_update",
	"pockode:canvas_update",
];

export function isCanvasRenderTool(toolName: string): boolean {
	return CANVAS_RENDER_NAMES.includes(toolName);
}

export function isCanvasUpdateTool(toolName: string): boolean {
	return CANVAS_UPDATE_NAMES.includes(toolName);
}

export function isCanvasTool(toolName: string): boolean {
	return isCanvasRenderTool(toolName) || isCanvasUpdateTool(toolName);
}
