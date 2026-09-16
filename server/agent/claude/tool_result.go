package claude

import (
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/contents"
)

// toolResultBlock is one element of a tool_result's content array. The CLI uses
// the Anthropic content block shapes, plus tool_reference for ToolSearch.
type toolResultBlock struct {
	Type   string `json:"type"`
	Text   string `json:"text,omitempty"`
	Source struct {
		Type      string `json:"type"`
		MediaType string `json:"media_type"`
		Data      string `json:"data"`
	} `json:"source,omitempty"`
	// ToolName is set on tool_reference blocks, which name a tool ToolSearch
	// found rather than carrying content of their own.
	ToolName string `json:"tool_name,omitempty"`
}

// toolResult is what one tool_result block says, in the two shapes
// agent.ToolResultEvent accepts: prose alone, or ordered blocks.
type toolResult struct {
	text   string
	blocks []agent.ContentBlock
}

// parseToolResult turns a tool_result's content into the result to report.
//
// Every element is looked at on its own. The array is the CLI's, and it mixes
// kinds freely — an MCP tool answers with its prose and its screenshot in one
// array, a PDF read answers with a line of text and the document — so deciding
// the array's fate from one element in it (as "does this contain an image"
// once did) throws away everything beside that element.
//
// Anything not recognised is passed through as its own raw JSON rather than
// dropped: a block type nobody has seen yet is then visible in the transcript,
// where it can be reported, instead of vanishing.
func parseToolResult(log *slog.Logger, store attachments.Store, content json.RawMessage) toolResult {
	// A result the CLI wrote as a plain JSON string is the common case and
	// carries nothing but prose.
	var text string
	if err := json.Unmarshal(content, &text); err == nil {
		return toolResult{text: text}
	}

	var items []json.RawMessage
	if len(content) == 0 || content[0] != '[' || json.Unmarshal(content, &items) != nil {
		// Not an array either: an object, or something that does not decode.
		// Hand over the raw JSON, which is what the transcript showed before
		// blocks existed.
		return toolResult{text: string(content)}
	}

	var blocks []agent.ContentBlock
	// Set by anything the UI cannot render as prose, which is what decides
	// whether the blocks are worth carrying at all.
	structured := false
	for _, item := range items {
		var elem toolResultBlock
		if err := json.Unmarshal(item, &elem); err != nil {
			log.Debug("tool result block did not decode", "error", err)
			blocks = append(blocks, agent.ContentBlock{Type: agent.ContentBlockText, Text: string(item)})
			continue
		}

		switch elem.Type {
		case "text":
			blocks = append(blocks, agent.ContentBlock{Type: agent.ContentBlockText, Text: elem.Text})

		case "image", "document":
			blocks = append(blocks, agent.ContentBlock{
				Type: agent.ContentBlockFile,
				File: fileBlock(log, store, elem, elem.Type == "image"),
			})
			structured = true

		case "tool_reference":
			// ToolSearch's answer, which reached the transcript as raw JSON
			// before this. A block of its own rather than a line of prose: the
			// name is the whole content, and the UI renders a list of tools.
			if elem.ToolName == "" {
				blocks = append(blocks, agent.ContentBlock{Type: agent.ContentBlockText, Text: string(item)})
				continue
			}
			blocks = append(blocks, agent.ContentBlock{
				Type:     agent.ContentBlockToolReference,
				ToolName: elem.ToolName,
			})
			structured = true

		default:
			log.Debug("unknown tool result block type", "blockType", elem.Type)
			blocks = append(blocks, agent.ContentBlock{Type: agent.ContentBlockText, Text: string(item)})
		}
	}

	if !structured {
		// Nothing a client needs blocks to render. Joined the way the all-text
		// array has always been joined, so the Agent tool's Markdown report
		// still reads as Markdown.
		texts := make([]string, 0, len(blocks))
		for _, block := range blocks {
			texts = append(texts, block.Text)
		}
		return toolResult{text: strings.Join(texts, "\n")}
	}

	return toolResult{blocks: blocks}
}

// fileBlock describes one image or document block, storing its bytes when they
// are worth storing.
//
// Only content a client can be shown is kept. An image is; a PDF is not — the
// UI lists it rather than rendering it, and the read that produced it names the
// file on disk in the text block beside it, so keeping half a megabyte of
// base64 per read would buy nothing. Same reasoning as the file namespace's,
// which omits non-image binaries too, and the same vocabulary for saying so.
//
// isImage comes from the CLI's own block type rather than from the media type
// beside it: the block type is what the CLI is asserting, and reading the
// answer off a string it also sends would turn a missing media_type into a
// dropped image.
func fileBlock(log *slog.Logger, store attachments.Store, elem toolResultBlock, isImage bool) *agent.FileBlock {
	file := &agent.FileBlock{MIME: elem.Source.MediaType}

	if elem.Source.Type != "base64" {
		// A URL source, or a shape that postdates this. Nothing to store and no
		// path to hand on: say the content is not available rather than claim
		// an empty one.
		log.Debug("tool result file block has no inline content", "sourceType", elem.Source.Type)
		file.Omitted = contents.OmitUnavailable
		return file
	}

	data, err := base64.StdEncoding.DecodeString(elem.Source.Data)
	if err != nil {
		log.Warn("failed to decode tool result file content", "error", err, "mime", file.MIME)
		file.Omitted = contents.OmitUnavailable
		return file
	}
	file.Size = int64(len(data))

	if !isImage {
		file.Omitted = contents.OmitBinary
		return file
	}

	file.Width, file.Height = agent.ImageDimensions(log, data)

	// The attachment travels back through one JSON-RPC message, so anything the
	// file namespace would refuse to send is not worth storing either.
	if file.Size > contents.MaxFileSize {
		file.Omitted = contents.OmitTooLarge
		file.Limit = contents.MaxFileSize
		return file
	}

	// No extension: the content arrived inline, with no file name to take one
	// from, and everything the CLI encodes is a format sniffing can name.
	id, err := store.Put(data, "")
	if err != nil {
		log.Warn("failed to store tool result attachment", "error", err, "mime", file.MIME)
		file.Omitted = contents.OmitUnavailable
		return file
	}
	file.AttachmentID = id
	return file
}
