package codex

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/contents"
)

// The Codex items beyond commands, patches, MCP calls and image views that are
// still tool calls: a web search or page open, an image generation, a sleep, a
// call about subagents other than a spawn, and a dynamic tool. Each is rebuilt
// field by field under a Pockode name, as toolCallOf does for the others
// (docs/tool-call-model.md#codex-items-beyond-commands-patches-and-mcp).

// Pockode's names for them. WebSearch and WebFetch are Claude's own, so the row,
// the group summary and the host naming apply unchanged.
const (
	webSearchToolName     = "WebSearch"
	webFetchToolName      = "WebFetch"
	generateImageToolName = "GenerateImage"
	sleepToolName         = "Sleep"
	agentControlToolName  = "AgentControl"
)

// webSearchItem is a webSearch item as codex-cli 0.171.0 sends it.
//
// Measured end to end on that version: item/started carries `query: ""` and
// `action: null` — nothing to name the call by — and item/completed carries
// both, plus `results`. So the call is announced on completion, immediately
// followed by its result (see webSearchCall).
type webSearchItem struct {
	Query  string `json:"query"`
	Action *struct {
		Type    string   `json:"type"`
		Query   string   `json:"query"`
		Queries []string `json:"queries"`
		URL     string   `json:"url"`
		Pattern string   `json:"pattern"`
	} `json:"action"`
	// Results is typed as opaque JSON by the schema. On 0.171.0 a search's
	// entries were `{type: "text_result", title, url, snippet, domain, …}` and a
	// page open's one entry named the page itself, its snippet a line count.
	Results []json.RawMessage `json:"results"`
}

// webSearchCall renders a webSearch item as WebSearch or WebFetch; ok is false
// while it names neither a query nor a page, which is how its start arrives.
func webSearchCall(item threadItem) (toolName string, input json.RawMessage, ok bool) {
	var ev webSearchItem
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		return "", nil, false
	}
	if ev.Action != nil && (ev.Action.Type == "openPage" || ev.Action.Type == "findInPage") {
		url := firstNonEmpty(ev.Action.URL, ev.Query)
		if url == "" {
			return "", nil, false
		}
		fields := map[string]string{"url": url}
		if ev.Action.Type == "findInPage" && ev.Action.Pattern != "" {
			fields["pattern"] = ev.Action.Pattern
		}
		input, _ = json.Marshal(fields)
		return webFetchToolName, input, true
	}

	fields := map[string]any{}
	var queries []string
	if ev.Action != nil {
		queries = nonEmpty(ev.Action.Queries)
		fields["query"] = firstNonEmpty(ev.Action.Query, ev.Query, firstOf(queries))
	} else {
		fields["query"] = ev.Query
	}
	if fields["query"] == "" {
		return "", nil, false
	}
	if len(queries) > 1 {
		fields["queries"] = queries
	}
	input, _ = json.Marshal(fields)
	return webSearchToolName, input, true
}

// webSearchResult is what a search found, in the shape Claude's WebSearch
// result arrives in — a header line, then `Links: [{title, url}]` — so the one
// reading of a search result the frontend has (web/src/lib/webSearchResult.ts)
// draws Codex's too. Only the entries naming a URL are read; anything else in
// the opaque array is passed over. Empty for a page open, whose one entry is
// the page the call already names, and for a search that reported nothing:
// the body then says Codex did not report what came back.
func webSearchResult(toolName string, item threadItem) string {
	if toolName != webSearchToolName {
		return ""
	}
	var ev webSearchItem
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		return ""
	}
	type link struct {
		Title string `json:"title,omitempty"`
		URL   string `json:"url"`
	}
	var links []link
	for _, raw := range ev.Results {
		var entry link
		if err := json.Unmarshal(raw, &entry); err != nil || entry.URL == "" {
			continue
		}
		links = append(links, entry)
	}
	if len(links) == 0 {
		return ""
	}
	query := ev.Query
	if ev.Action != nil {
		query = firstNonEmpty(ev.Action.Query, query)
	}
	encoded, _ := json.Marshal(links)
	// One line: the header is matched as a whole line.
	query = strings.Join(strings.Fields(query), " ")
	return fmt.Sprintf("Web search results for query: %q\n\nLinks: %s", query, encoded)
}

// emitWebSearchCompleted reports a finished web search: its call first when its
// start named nothing to announce, then its result. The item carries no status,
// so it never reads as failed.
func (s *appSession) emitWebSearchCompleted(item threadItem, announced bool) {
	toolName, input, ok := webSearchCall(item)
	if !ok {
		s.log.Warn("webSearch item named neither a query nor a page", "itemId", item.ID)
		return
	}
	if !announced {
		s.emitEvent(agent.ToolCallEvent{
			ToolUseID:         item.ID,
			ToolName:          toolName,
			ToolInput:         input,
			ParentToolUseID:   item.ParentToolUseID,
			ProviderMessageID: item.TurnID,
		})
	}
	s.emitEvent(agent.ToolResultEvent{
		ToolUseID:         item.ID,
		ToolResult:        webSearchResult(toolName, item),
		ParentToolUseID:   item.ParentToolUseID,
		ProviderMessageID: item.TurnID,
	})
}

// imageGenerationItem is an imageGeneration item. Measured on codex-cli
// 0.171.0: item/started carries `revisedPrompt: null` and no `savedPath`;
// item/completed carries both, and `result`, the image again as base64, which
// the schema does not list and which is not read.
type imageGenerationItem struct {
	Status        string  `json:"status"`
	RevisedPrompt *string `json:"revisedPrompt"`
	SavedPath     string  `json:"savedPath"`
	Failure       *struct {
		Type     string `json:"type"`
		ResetsAt *int64 `json:"resetsAt"`
	} `json:"failure"`
}

// imageGenerationCall is announced at item/started either way — a generation
// takes long enough that a row appearing only at the end would hide it — with
// the prompt only when the start carried one, which 0.171.0's does not. The
// prompt is then known from the result.
func imageGenerationCall(item threadItem) (json.RawMessage, bool) {
	var ev imageGenerationItem
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		return nil, false
	}
	fields := map[string]string{}
	if ev.RevisedPrompt != nil && *ev.RevisedPrompt != "" {
		fields["prompt"] = *ev.RevisedPrompt
	}
	input, _ := json.Marshal(fields)
	return input, true
}

// handleImageGenerationCompleted reports a generated image: the prompt Codex
// used as text, then the image as a file block copied into the session's
// attachment store, the way an imageView's is (viewedImage). The file is under
// Codex's own directory, not the work directory, which is why it is an
// attachment and not a file change.
func (s *appSession) handleImageGenerationCompleted(item threadItem) {
	result := agent.ToolResultEvent{
		ToolUseID:         item.ID,
		ParentToolUseID:   item.ParentToolUseID,
		ProviderMessageID: item.TurnID,
	}
	var ev imageGenerationItem
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		s.log.Warn("failed to parse imageGeneration item", "error", err)
		result.IsError = true
		result.ToolResult = "Pockode could not read this image generation's result."
		s.emitEvent(result)
		return
	}
	if ev.Failure != nil || ev.Status != itemStatusCompleted {
		result.IsError = true
		result.ToolResult = describeFailedImageGeneration(ev, time.Now())
		s.emitEvent(result)
		return
	}

	var blocks []agent.ContentBlock
	if ev.RevisedPrompt != nil && *ev.RevisedPrompt != "" {
		blocks = append(blocks, agent.ContentBlock{Type: agent.ContentBlockText, Text: *ev.RevisedPrompt})
	}
	blocks = append(blocks, agent.ContentBlock{Type: agent.ContentBlockFile, File: s.generatedImage(ev)})
	result.Contents = blocks
	s.emitEvent(result)
}

// generatedImage is the file block for a finished generation: the file at
// savedPath, copied as an imageView's is. The base64 copy the item also
// carries is not read: savedPath was there on every completed generation
// measured, and a generation without one is said to be missing rather than
// decoded from a field the schema does not promise.
func (s *appSession) generatedImage(ev imageGenerationItem) *agent.FileBlock {
	if path := localPath(ev.SavedPath); path != "" {
		return viewedImage(s.log, s.attachments, path)
	}
	s.log.Warn("imageGeneration named no saved image")
	return &agent.FileBlock{Name: "Generated image", Omitted: contents.OmitUnavailable}
}

// describeFailedImageGeneration words a failed generation from its kind. The
// reset time is written in the server's local time zone, the user's own on the
// machine Pockode runs on.
func describeFailedImageGeneration(ev imageGenerationItem, now time.Time) string {
	if ev.Failure == nil || ev.Failure.Type != "usageLimitExceeded" {
		if ev.Status == itemStatusDeclined {
			return deniedByUser
		}
		return "The image could not be generated."
	}
	text := "Image generation limit reached"
	if ev.Failure.ResetsAt != nil {
		at := time.Unix(*ev.Failure.ResetsAt, 0).In(now.Location())
		layout := "15:04"
		if y, m, d := at.Date(); y != now.Year() || m != now.Month() || d != now.Day() {
			layout = "Jan 2 15:04"
		}
		text += " · resets " + at.Format(layout)
	}
	return text
}

// sleepCall renders a sleep item. The item's durationMs is the wait asked for,
// not a measurement, so it is the call's input and never the result's
// duration: the row's time is the observed one.
func sleepCall(item threadItem) (json.RawMessage, bool) {
	var ev struct {
		DurationMs *uint64 `json:"durationMs"`
	}
	if err := json.Unmarshal(item.Raw, &ev); err != nil || ev.DurationMs == nil {
		return nil, false
	}
	input, _ := json.Marshal(map[string]uint64{"duration_ms": *ev.DurationMs})
	return input, true
}

// collabAgentItem is a collabAgentToolCall item; a spawnAgent one is a
// subagent (spawnOf), every other tool a call about subagents.
type collabAgentItem struct {
	Tool              string   `json:"tool"`
	Status            string   `json:"status"`
	ReceiverThreadIDs []string `json:"receiverThreadIds"`
	Prompt            *string  `json:"prompt"`
	AgentsStates      map[string]struct {
		Status string `json:"status"`
	} `json:"agentsStates"`
}

// agentControlCall renders a collabAgentToolCall that is not a spawn.
//
// The agents are named by the path their spawn named, and null in place of one
// whose spawn named none or was not seen: a thread id is no name, and the
// count still says how many there were.
func (s *appSession) agentControlCall(item threadItem) (json.RawMessage, bool) {
	var ev collabAgentItem
	if err := json.Unmarshal(item.Raw, &ev); err != nil || ev.Tool == "" || ev.Tool == "spawnAgent" {
		return nil, false
	}
	agents := make([]*string, 0, len(ev.ReceiverThreadIDs))
	for _, id := range ev.ReceiverThreadIDs {
		agents = append(agents, s.agentPathOf(id))
	}
	fields := map[string]any{"action": ev.Tool, "agents": agents}
	if ev.Prompt != nil && *ev.Prompt != "" {
		fields["prompt"] = *ev.Prompt
	}
	input, _ := json.Marshal(fields)
	return input, true
}

func (s *appSession) agentPathOf(threadID string) *string {
	if path := s.subagentCalls[threadID].AgentPath; path != "" {
		return &path
	}
	return nil
}

// agentControlResult reports the receivers' last known states, one line each,
// `agent: status`, in the order the call named them. An agent is named as its
// call input names it, `agent` where that is null.
func (s *appSession) agentControlResult(item threadItem) agent.ToolResultEvent {
	result := agent.ToolResultEvent{
		ToolUseID:         item.ID,
		ParentToolUseID:   item.ParentToolUseID,
		ProviderMessageID: item.TurnID,
	}
	var ev collabAgentItem
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		result.IsError = true
		result.ToolResult = "Pockode could not read this agent call's result."
		return result
	}
	// A state for an agent the call did not name (a listAgents may answer with
	// every agent) still belongs in the answer, after the named ones, in an
	// order that does not change between runs.
	var others []string
	for id := range ev.AgentsStates {
		if !slices.Contains(ev.ReceiverThreadIDs, id) {
			others = append(others, id)
		}
	}
	slices.Sort(others)
	ids := append(slices.Clone(ev.ReceiverThreadIDs), others...)
	var lines []string
	for _, id := range ids {
		state, ok := ev.AgentsStates[id]
		if !ok {
			continue
		}
		name := "agent"
		if path := s.agentPathOf(id); path != nil {
			name = *path
		}
		lines = append(lines, name+": "+state.Status)
	}
	result.ToolResult = strings.Join(lines, "\n")
	result.IsError = ev.Status != itemStatusCompleted
	if result.IsError && result.ToolResult == "" {
		result.ToolResult = fmt.Sprintf("The agent call ended %s.", firstNonEmpty(ev.Status, "without a status"))
	}
	return result
}

// dynamicToolItem is a dynamicToolCall item: a tool the client registered on
// thread/start. Pockode registers none, so none arrives today; it is mapped so
// that the day one is registered its calls do not vanish.
type dynamicToolItem struct {
	Namespace    string          `json:"namespace"`
	Tool         string          `json:"tool"`
	Arguments    json.RawMessage `json:"arguments"`
	Status       string          `json:"status"`
	Success      *bool           `json:"success"`
	DurationMs   *int64          `json:"durationMs"`
	ContentItems []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"contentItems"`
}

// dynamicToolCall is named as an MCP call is, `namespace:tool`, since that is
// what it is — `dynamic:tool` without a namespace — and its arguments are
// passed through as an MCP call's are.
func dynamicToolCall(item threadItem) (toolName string, input json.RawMessage, ok bool) {
	var ev dynamicToolItem
	if err := json.Unmarshal(item.Raw, &ev); err != nil || ev.Tool == "" {
		return "", nil, false
	}
	input = ev.Arguments
	if len(input) == 0 || string(input) == "null" {
		input = json.RawMessage("{}")
	}
	return firstNonEmpty(ev.Namespace, "dynamic") + ":" + ev.Tool, input, true
}

// dynamicToolResult joins the text a dynamic tool answered with. An image or
// audio item is not drawn, and is counted on a last line instead, so the
// answer never reads as shorter than it was.
func dynamicToolResult(item threadItem) agent.ToolResultEvent {
	result := agent.ToolResultEvent{
		ToolUseID:         item.ID,
		ParentToolUseID:   item.ParentToolUseID,
		ProviderMessageID: item.TurnID,
	}
	var ev dynamicToolItem
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		result.IsError = true
		result.ToolResult = "Pockode could not read this tool call's result."
		return result
	}
	var parts []string
	images, audio := 0, 0
	for _, c := range ev.ContentItems {
		switch c.Type {
		case "inputText":
			if c.Text != "" {
				parts = append(parts, c.Text)
			}
		case "inputImage":
			images++
		case "inputAudio":
			audio++
		}
	}
	parts = append(parts, notShown(images, "image")...)
	parts = append(parts, notShown(audio, "audio clip")...)
	result.ToolResult = strings.Join(parts, "\n")
	result.IsError = ev.Status != itemStatusCompleted || (ev.Success != nil && !*ev.Success)
	if ev.DurationMs != nil {
		result.DurationMs = *ev.DurationMs
	}
	return result
}

// notShown is the line saying what was left out — "1 image not shown" — or
// none when nothing was.
func notShown(n int, noun string) []string {
	if n == 0 {
		return nil
	}
	return []string{fmt.Sprintf("%d %s not shown", n, plural(n, noun))}
}

func plural(n int, noun string) string {
	if n == 1 {
		return noun
	}
	return noun + "s"
}

func nonEmpty(values []string) []string {
	var out []string
	for _, v := range values {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

func firstOf(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
