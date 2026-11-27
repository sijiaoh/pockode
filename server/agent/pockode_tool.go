package agent

import "strings"

// PockodeTool is the bare name of a call into Pockode's own MCP server
// (MCPServerName), by either of the names it arrives under: Claude passes
// `mcp__<server>__<tool>` through, Codex's adapter joins `<server>:<tool>`
// (agent/codex mcpToolCall). Any other call answers false.
func PockodeTool(toolName string) (string, bool) {
	if tool, ok := strings.CutPrefix(toolName, "mcp__"+MCPServerName+"__"); ok {
		return tool, true
	}
	if tool, ok := strings.CutPrefix(toolName, MCPServerName+":"); ok {
		return tool, true
	}
	return "", false
}
