package codex

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/contents"
)

func itemNotification(item string) string {
	return `{"threadId":"t","turnId":"u","startedAtMs":1,"completedAtMs":2,"item":` + item + `}`
}

// The pair codex-cli 0.171.0 sent for one search, measured end to end: the
// start names nothing, so the call is announced on completion and followed by
// its result straight away.
func TestWebSearch_AnnouncedOnCompletion(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/started", itemNotification(`{"type":"webSearch","id":"ws","query":"","action":null,"results":null}`))
	if events := drainEvents(sess.events); len(events) != 0 {
		t.Fatalf("a start naming nothing announced %v", events)
	}

	sess.notify("item/completed", itemNotification(`{"type":"webSearch","id":"ws","query":"golang 1.25 release notes",
		"action":{"type":"search","query":"golang 1.25 release notes","queries":null},
		"results":[{"type":"text_result","domain":"go.dev","title":"Go 1.25 Release Notes","url":"https://go.dev/doc/go1.25","snippet":"…"},
			{"type":"image_result"},
			{"type":"text_result","url":"https://example.com/untitled"}]}`))

	events := drainEvents(sess.events)
	if len(events) != 2 {
		t.Fatalf("events = %v, want the call then its result", events)
	}
	call := events[0].(agent.ToolCallEvent)
	if call.ToolName != "WebSearch" || string(call.ToolInput) != `{"query":"golang 1.25 release notes"}` || call.ProviderMessageID != "u" {
		t.Errorf("call = %+v", call)
	}
	result := events[1].(agent.ToolResultEvent)
	want := "Web search results for query: \"golang 1.25 release notes\"\n\n" +
		`Links: [{"title":"Go 1.25 Release Notes","url":"https://go.dev/doc/go1.25"},{"url":"https://example.com/untitled"}]`
	if result.ToolUseID != "ws" || result.ToolResult != want || result.IsError {
		t.Errorf("result = %+v, want %q", result, want)
	}
}

func TestWebSearch_Inputs(t *testing.T) {
	tests := []struct {
		name, item string
		wantName   string
		wantInput  string
		wantResult string
	}{
		{
			name:      "several queries",
			item:      `{"type":"webSearch","id":"ws","query":"a","action":{"type":"search","query":null,"queries":["a","b"]}}`,
			wantName:  "WebSearch",
			wantInput: `{"queries":["a","b"],"query":"a"}`,
		},
		{
			name:      "an other action",
			item:      `{"type":"webSearch","id":"ws","query":"weather","action":{"type":"other"}}`,
			wantName:  "WebSearch",
			wantInput: `{"query":"weather"}`,
		},
		{
			// Measured: a page open's one result is the page itself.
			name:      "a page open",
			item:      `{"type":"webSearch","id":"ws","query":"https://go.dev/doc/go1.25","action":{"type":"openPage","url":"https://go.dev/doc/go1.25"},"results":[{"type":"text_result","title":"Go 1.25","url":"https://go.dev/doc/go1.25","snippet":"Total lines: 455"}]}`,
			wantName:  "WebFetch",
			wantInput: `{"url":"https://go.dev/doc/go1.25"}`,
		},
		{
			name:      "a find in page",
			item:      `{"type":"webSearch","id":"ws","query":"","action":{"type":"findInPage","url":"https://go.dev/","pattern":"iterator"}}`,
			wantName:  "WebFetch",
			wantInput: `{"pattern":"iterator","url":"https://go.dev/"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			sess.notify("item/completed", itemNotification(tt.item))

			events := drainEvents(sess.events)
			if len(events) != 2 {
				t.Fatalf("events = %v", events)
			}
			call := events[0].(agent.ToolCallEvent)
			if call.ToolName != tt.wantName || string(call.ToolInput) != tt.wantInput {
				t.Errorf("call = %s %s, want %s %s", call.ToolName, call.ToolInput, tt.wantName, tt.wantInput)
			}
			if result := events[1].(agent.ToolResultEvent); result.ToolResult != tt.wantResult || result.IsError {
				t.Errorf("result = %+v, want %q", result, tt.wantResult)
			}
		})
	}
}

// A start that does name its query is announced there, and not again.
func TestWebSearch_AnnouncedOnceWhenTheStartNamesIt(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	item := `{"type":"webSearch","id":"ws","query":"q","action":{"type":"search","query":"q"}}`
	sess.notify("item/started", itemNotification(item))
	sess.notify("item/completed", itemNotification(item))

	events := drainEvents(sess.events)
	if len(events) != 2 {
		t.Fatalf("events = %v, want one call and one result", events)
	}
	if _, ok := events[0].(agent.ToolCallEvent); !ok {
		t.Errorf("first = %#v, want the call", events[0])
	}
	if _, ok := events[1].(agent.ToolResultEvent); !ok {
		t.Errorf("second = %#v, want the result", events[1])
	}
}

// Measured on 0.171.0: the start carries no prompt and no path; the
// completion carries both.
func TestImageGeneration(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.attachments = attachments.NewStore(t.TempDir(), "session-1")
	path := writeFile(t, t.TempDir(), "exec-1.png", pngBytes(t, 4, 3))

	sess.notify("item/started", itemNotification(`{"type":"imageGeneration","id":"ig","status":"in_progress","revisedPrompt":null,"result":"","failure":null}`))
	item, _ := json.Marshal(map[string]any{
		"type": "imageGeneration", "id": "ig", "status": "completed",
		"revisedPrompt": "A blue square on white.", "result": "iVBOR…", "savedPath": path,
	})
	sess.notify("item/completed", itemNotification(string(item)))

	events := drainEvents(sess.events)
	if len(events) != 2 {
		t.Fatalf("events = %v", events)
	}
	call := events[0].(agent.ToolCallEvent)
	if call.ToolName != "GenerateImage" || string(call.ToolInput) != `{}` {
		t.Errorf("call = %s %s, want GenerateImage with no prompt yet", call.ToolName, call.ToolInput)
	}
	result := events[1].(agent.ToolResultEvent)
	if result.IsError || len(result.Contents) != 2 {
		t.Fatalf("result = %+v, want the prompt and the image", result)
	}
	if text := result.Contents[0]; text.Type != agent.ContentBlockText || text.Text != "A blue square on white." {
		t.Errorf("first block = %+v, want the revised prompt", text)
	}
	file := result.Contents[1].File
	if result.Contents[1].Type != agent.ContentBlockFile || file == nil || file.AttachmentID == "" || file.Width != 4 || file.Height != 3 {
		t.Errorf("second block = %+v, want the image copied into the attachment store", result.Contents[1])
	}
}

// A prompt the start carries is the call's input.
func TestImageGeneration_PromptAtStart(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/started", itemNotification(`{"type":"imageGeneration","id":"ig","status":"in_progress","revisedPrompt":"a cat"}`))

	call := drainEvents(sess.events)[0].(agent.ToolCallEvent)
	if string(call.ToolInput) != `{"prompt":"a cat"}` {
		t.Errorf("input = %s", call.ToolInput)
	}
}

func TestImageGeneration_NoSavedPath(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/completed", itemNotification(`{"type":"imageGeneration","id":"ig","status":"completed","revisedPrompt":null}`))

	result := drainEvents(sess.events)[0].(agent.ToolResultEvent)
	if len(result.Contents) != 1 || result.Contents[0].File == nil || result.Contents[0].File.Omitted != contents.OmitUnavailable {
		t.Errorf("result = %+v, want one image said to be unavailable", result)
	}
}

func TestDescribeFailedImageGeneration(t *testing.T) {
	now := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	at := func(t time.Time) *int64 { u := t.Unix(); return &u }
	limit := func(resets *int64) imageGenerationItem {
		ev := imageGenerationItem{Status: "failed"}
		ev.Failure = &struct {
			Type     string `json:"type"`
			ResetsAt *int64 `json:"resetsAt"`
		}{Type: "usageLimitExceeded", ResetsAt: resets}
		return ev
	}
	tests := []struct {
		name string
		ev   imageGenerationItem
		want string
	}{
		{"limit, no reset time", limit(nil), "Image generation limit reached"},
		{"limit, resets today", limit(at(now.Add(4*time.Hour + 5*time.Minute))), "Image generation limit reached · resets 14:05"},
		{"limit, resets another day", limit(at(now.Add(26 * time.Hour))), "Image generation limit reached · resets Nov 28 12:00"},
		{"failed otherwise", imageGenerationItem{Status: "failed"}, "The image could not be generated."},
		{"declined", imageGenerationItem{Status: "declined"}, deniedByUser},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := describeFailedImageGeneration(tt.ev, now); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestImageGeneration_Failed(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/completed", itemNotification(`{"type":"imageGeneration","id":"ig","status":"failed","failure":{"type":"usageLimitExceeded","limitId":"l"}}`))

	result := drainEvents(sess.events)[0].(agent.ToolResultEvent)
	if !result.IsError || result.ToolResult != "Image generation limit reached" || result.Contents != nil {
		t.Errorf("result = %+v", result)
	}
}

// The item's durationMs is the wait asked for: the call's input, and never
// the result's measured duration.
func TestSleep(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	item := itemNotification(`{"type":"sleep","id":"sl","durationMs":30000}`)
	sess.notify("item/started", item)
	sess.notify("item/completed", item)

	events := drainEvents(sess.events)
	call := events[0].(agent.ToolCallEvent)
	if call.ToolName != "Sleep" || string(call.ToolInput) != `{"duration_ms":30000}` {
		t.Errorf("call = %s %s", call.ToolName, call.ToolInput)
	}
	result := events[1].(agent.ToolResultEvent)
	if result.ToolResult != "" || result.DurationMs != 0 || result.IsError {
		t.Errorf("result = %+v, want an empty success with no reported duration", result)
	}
}

// An item not read as a call is announced by neither half: a result would
// name a call that no record holds.
func TestUnreadableItemsLeaveNoResult(t *testing.T) {
	for _, raw := range []string{
		`{"type":"sleep","id":"sl"}`,
		`{"type":"dynamicToolCall","id":"dy","status":"completed","contentItems":[]}`,
	} {
		sess := newTestSession()
		item := itemNotification(raw)
		sess.notify("item/started", item)
		sess.notify("item/completed", item)
		for _, ev := range drainEvents(sess.events) {
			switch ev.(type) {
			case agent.ToolCallEvent, agent.ToolResultEvent:
				t.Errorf("%s: emitted %+v", raw, ev)
			}
		}
		sess.cancel()
	}
}

// A wait on a subagent whose spawn named its path, and one on a thread whose
// spawn was not seen.
func TestAgentControl(t *testing.T) {
	sess := newSubagentTestSession()
	defer sess.cancel()

	sess.notify("item/started", `{"threadId":"main","turnId":"turn-main","startedAtMs":1,"item":{
		"type":"collabAgentToolCall","id":"wait-1","tool":"wait","status":"inProgress",
		"senderThreadId":"main","receiverThreadIds":["child","stranger"],"agentsStates":{}}}`)
	sess.notify("item/completed", `{"threadId":"main","turnId":"turn-main","completedAtMs":2,"item":{
		"type":"collabAgentToolCall","id":"wait-1","tool":"wait","status":"completed",
		"senderThreadId":"main","receiverThreadIds":["child","stranger"],
		"agentsStates":{"stranger":{"status":"running"},"child":{"status":"completed","message":"done"},"extra":{"status":"shutdown"}}}}`)

	events := drainEvents(sess.events)
	if len(events) != 2 {
		t.Fatalf("events = %v", events)
	}
	call := events[0].(agent.ToolCallEvent)
	if call.ToolName != "AgentControl" || string(call.ToolInput) != `{"action":"wait","agents":["/root/reader",null]}` {
		t.Errorf("call = %s %s", call.ToolName, call.ToolInput)
	}
	result := events[1].(agent.ToolResultEvent)
	if want := "/root/reader: completed\nagent: running\nagent: shutdown"; result.ToolResult != want || result.IsError {
		t.Errorf("result = %q, want %q", result.ToolResult, want)
	}
}

func TestAgentControl_PromptAndFailure(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/started", itemNotification(`{"type":"collabAgentToolCall","id":"c","tool":"sendMessage","status":"inProgress",
		"senderThreadId":"t","receiverThreadIds":["x"],"prompt":"keep going","agentsStates":{}}`))
	sess.notify("item/completed", itemNotification(`{"type":"collabAgentToolCall","id":"c","tool":"sendMessage","status":"failed",
		"senderThreadId":"t","receiverThreadIds":["x"],"prompt":"keep going","agentsStates":{}}`))

	events := drainEvents(sess.events)
	call := events[0].(agent.ToolCallEvent)
	if string(call.ToolInput) != `{"action":"sendMessage","agents":[null],"prompt":"keep going"}` {
		t.Errorf("input = %s", call.ToolInput)
	}
	result := events[1].(agent.ToolResultEvent)
	if !result.IsError || result.ToolResult != "The agent call ended failed." {
		t.Errorf("result = %+v", result)
	}
}

// A spawn is a subagent, never an AgentControl.
func TestAgentControl_NotForASpawn(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/started", itemNotification(`{"type":"collabAgentToolCall","id":"c","tool":"spawnAgent","status":"inProgress",
		"senderThreadId":"t","receiverThreadIds":[],"prompt":"go","agentsStates":{}}`))

	for _, ev := range drainEvents(sess.events) {
		if call, ok := ev.(agent.ToolCallEvent); ok && call.ToolName == "AgentControl" {
			t.Errorf("a spawn was announced as %+v", call)
		}
	}
}

func TestDynamicToolCall(t *testing.T) {
	tests := []struct {
		name, item  string
		wantName    string
		wantInput   string
		wantResult  string
		wantIsError bool
	}{
		{
			name:       "namespaced",
			item:       `{"type":"dynamicToolCall","id":"d","namespace":"app","tool":"lookup","arguments":{"q":1},"status":"completed","success":true,"contentItems":[{"type":"inputText","text":"one"},{"type":"inputText","text":"two"}]}`,
			wantName:   "app:lookup",
			wantInput:  `{"q":1}`,
			wantResult: "one\ntwo",
		},
		{
			name:       "no namespace, images and audio",
			item:       `{"type":"dynamicToolCall","id":"d","tool":"snap","arguments":null,"status":"completed","contentItems":[{"type":"inputImage","imageUrl":"x"},{"type":"inputImage","imageUrl":"y"},{"type":"inputAudio","audioUrl":"z"}]}`,
			wantName:   "dynamic:snap",
			wantInput:  `{}`,
			wantResult: "2 images not shown\n1 audio clip not shown",
		},
		{
			name:        "unsuccessful",
			item:        `{"type":"dynamicToolCall","id":"d","tool":"t","arguments":{},"status":"completed","success":false,"contentItems":[{"type":"inputText","text":"nope"}]}`,
			wantName:    "dynamic:t",
			wantInput:   `{}`,
			wantResult:  "nope",
			wantIsError: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			sess.notify("item/started", itemNotification(tt.item))
			sess.notify("item/completed", itemNotification(tt.item))

			events := drainEvents(sess.events)
			call := events[0].(agent.ToolCallEvent)
			if call.ToolName != tt.wantName || string(call.ToolInput) != tt.wantInput {
				t.Errorf("call = %s %s", call.ToolName, call.ToolInput)
			}
			result := events[1].(agent.ToolResultEvent)
			if result.ToolResult != tt.wantResult || result.IsError != tt.wantIsError {
				t.Errorf("result = %+v", result)
			}
		})
	}
}

// The items the design keeps out of the transcript stay out.
func TestStillDroppedItems(t *testing.T) {
	for _, item := range []string{
		`{"type":"plan","id":"p","text":"1. do it"}`,
		`{"type":"contextCompaction","id":"c"}`,
		`{"type":"enteredReviewMode","id":"r","review":"x"}`,
		`{"type":"exitedReviewMode","id":"r","review":"x"}`,
		`{"type":"hookPrompt","id":"h","fragments":[]}`,
		`{"type":"functionCallOutput","id":"f","name":"n","output":"o"}`,
	} {
		sess := newTestSession()
		sess.notify("item/started", itemNotification(item))
		sess.notify("item/completed", itemNotification(item))
		for _, ev := range drainEvents(sess.events) {
			switch ev.(type) {
			case agent.ToolCallEvent, agent.ToolResultEvent:
				t.Errorf("%s produced %#v", strings.SplitN(item, ",", 2)[0], ev)
			}
		}
		sess.cancel()
	}
}
