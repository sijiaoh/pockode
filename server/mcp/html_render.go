package mcp

import (
	"encoding/json"
	"fmt"
	"strings"
)

// maxHTMLRenderBytes bounds what one html_render call may carry. The call's
// input is the only record of the page and is kept in the session history like
// any tool call, so the cap is on what that history can afford, not on what a
// browser could draw.
const maxHTMLRenderBytes = 256 * 1024

// htmlRender only validates: there is nothing to store, because the frontend
// draws the page straight from the tool call's input.
func htmlRender(args json.RawMessage) (string, error) {
	var params struct {
		Title string `json:"title"`
		HTML  string `json:"html"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	if strings.TrimSpace(params.Title) == "" {
		return "", userErrorf("title is required: name what the page shows")
	}
	// Whitespace alone renders as a blank frame, which is no page at all.
	if strings.TrimSpace(params.HTML) == "" {
		return "", userErrorf("html is required: pass the page to render")
	}
	if len(params.HTML) > maxHTMLRenderBytes {
		return "", userErrorf("html is %d bytes, over the %d-byte (256KB) limit: trim it, e.g. by loading large libraries from a CDN instead of inlining them", len(params.HTML), maxHTMLRenderBytes)
	}
	return fmt.Sprintf("Page %q is shown to the user; do not repeat its content in your reply.", params.Title), nil
}
