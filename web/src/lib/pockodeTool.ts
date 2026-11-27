/**
 * The bare name of a call into Pockode's own MCP server, by either name it
 * arrives under — Claude passes `mcp__pockode__<tool>` through, Codex's
 * adapter joins `pockode:<tool>` — or null for any other call. The server's
 * counterpart is `agent.PockodeTool`.
 */
export function pockodeTool(toolName: string): string | null {
	if (toolName.startsWith("mcp__pockode__")) {
		return toolName.slice("mcp__pockode__".length);
	}
	if (toolName.startsWith("pockode:")) return toolName.slice("pockode:".length);
	return null;
}
