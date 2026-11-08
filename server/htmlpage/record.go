package htmlpage

import (
	"encoding/json"
	"strings"
)

// pageTools are Pockode's MCP tools whose successful result names the page
// the call stored. A tool that stores a page is added here, and its result
// starts with ResultLead.
var pageTools = map[string]bool{
	"html_render": true,
	"html_edit":   true,
}

// IsPageTool reports whether a tool call is one of pageTools, by either of
// the names it arrives under: Claude passes `mcp__<server>__<tool>` through,
// Codex's adapter joins `<server>:<tool>` (agent/codex mcpToolCall).
func IsPageTool(toolName string) bool {
	if tool, ok := strings.CutPrefix(toolName, "mcp__pockode__"); ok {
		return pageTools[tool]
	}
	if tool, ok := strings.CutPrefix(toolName, "pockode:"); ok {
		return pageTools[tool]
	}
	return false
}

// ResultLead is how a page tool's result begins: the agent reads the id
// there, and the server reads it back (IDFromResult) to put it on the
// record.
//
// The result is the only way the id can travel: an MCP call does not carry the
// CLI's tool call id, so the executor that stores the page cannot name the
// record, and the process that writes the record learns the page only from
// what the call returned.
func ResultLead(id string) string {
	return "Page " + id
}

// IDFromResult is the page id a page tool's result begins with.
func IDFromResult(result string) (string, bool) {
	rest, ok := strings.CutPrefix(result, ResultLead(idPrefix))
	if !ok {
		return "", false
	}
	end := strings.IndexFunc(rest, func(r rune) bool { return r < '0' || r > '9' })
	if end < 0 {
		end = len(rest)
	}
	id := idPrefix + rest[:end]
	if _, ok := ParseID(id); !ok {
		return "", false
	}
	return id, true
}

// HighestInRecords is the highest page number any of records names in its
// html_page field (agent.EventRecord.HTMLPage), 0 when none does. A fork
// copies the pages up to it (Clone).
func HighestInRecords(records []json.RawMessage) int {
	highest := 0
	for _, raw := range records {
		// Cheap pre-check: nearly every record names no page, and decoding each
		// one in full to find that out would cost the whole history.
		if !strings.Contains(string(raw), `"html_page"`) {
			continue
		}
		var rec struct {
			HTMLPage string `json:"html_page"`
		}
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		if n, ok := ParseID(rec.HTMLPage); ok {
			highest = max(highest, n)
		}
	}
	return highest
}
