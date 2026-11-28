package agent

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/pockode/server/htmlpage"
	"github.com/pockode/server/session"
)

// legacyEventRecord is the single flat struct every record used to be
// serialized through, frozen as it was when the per-type records replaced it.
// It is the compatibility contract in executable form: a server from before
// the split wrote this and read this, so what the per-type records write must
// be byte-identical to it, and what it wrote must decode into them losslessly.
//
// Never edit it. A field added to a record type after the split has no
// counterpart here, and its cases belong in an ordinary round-trip test.
type legacyEventRecord struct {
	Type                  EventType           `json:"type"`
	Content               string              `json:"content,omitempty"`
	ToolName              string              `json:"tool_name,omitempty"`
	ToolInput             json.RawMessage     `json:"tool_input,omitempty"`
	ToolUseID             string              `json:"tool_use_id,omitempty"`
	OriginToolUseID       string              `json:"origin_tool_use_id,omitempty"`
	ParentToolUseID       string              `json:"parent_tool_use_id,omitempty"`
	ToolResult            string              `json:"tool_result,omitempty"`
	Contents              []ContentBlock      `json:"contents,omitempty"`
	IsError               bool                `json:"is_error,omitempty"`
	Error                 string              `json:"error,omitempty"`
	Message               string              `json:"message,omitempty"`
	Code                  string              `json:"code,omitempty"`
	AuthFailure           *AuthFailure        `json:"auth_failure,omitempty"`
	UsageLimit            *UsageLimit         `json:"usage_limit,omitempty"`
	RequestID             string              `json:"request_id,omitempty"`
	PermissionSuggestions []PermissionUpdate  `json:"permission_suggestions,omitempty"`
	Questions             []AskUserQuestion   `json:"questions,omitempty"`
	Choice                string              `json:"choice,omitempty"`
	DecisionReason        string              `json:"decision_reason,omitempty"`
	BlockedPath           string              `json:"blocked_path,omitempty"`
	By                    PermissionResponder `json:"by,omitempty"`
	Review                *PermissionReview   `json:"review,omitempty"`
	Reason                CancelReason        `json:"reason,omitempty"`
	AskedAt               *time.Time          `json:"asked_at,omitempty"`
	ResolvedAt            *time.Time          `json:"resolved_at,omitempty"`
	ObservedAt            *time.Time          `json:"observed_at,omitempty"`
	Answering             []QuestionAnswer    `json:"answering,omitempty"`
	Command               *CommandInvocation  `json:"command,omitempty"`
	HTMLAction            *htmlpage.Action    `json:"html_action,omitempty"`
	Attachments           []FileBlock         `json:"attachments,omitempty"`
	Origin                MessageOrigin       `json:"origin,omitempty"`
	MessageID             string              `json:"message_id,omitempty"`
	Subtype               string              `json:"subtype,omitempty"`
	Meta                  *MessageMeta        `json:"meta,omitempty"`
	DurationMs            int64               `json:"duration_ms,omitempty"`
	ExitCode              *int                `json:"exit_code,omitempty"`
	Subagent              *SubagentReport     `json:"subagent,omitempty"`
	HTMLPage              string              `json:"html_page,omitempty"`
	WorkRef               *WorkRef            `json:"work_ref,omitempty"`
	Activity              string              `json:"activity,omitempty"`
	OutputDelta           string              `json:"output_delta,omitempty"`
	SubagentProgress      *SubagentProgress   `json:"subagent_progress,omitempty"`
	FullReasoning         string              `json:"full_reasoning,omitempty"`
	Redacted              bool                `json:"redacted,omitempty"`
	ContentDelta          string              `json:"content_delta,omitempty"`
	FullReasoningDelta    string              `json:"full_reasoning_delta,omitempty"`
	Steps                 []PlanStep          `json:"steps,omitempty"`
	Explanation           string              `json:"explanation,omitempty"`
	PlanID                string              `json:"plan_id,omitempty"`
	ProviderMessageID     string              `json:"provider_message_id,omitempty"`
}

// wireCompatCase is one wire value with every field its type has set — so a
// field missing from the new type, or tagged differently, shows up as a
// difference — beside the flat record the old server wrote for the same
// event.
type wireCompatCase struct {
	name   string
	wire   Wire
	legacy legacyEventRecord
}

func wireCompatCases() []wireCompatCase {
	at := time.Date(2026, 11, 28, 9, 30, 0, 123, time.UTC)
	later := at.Add(time.Minute)
	exit := 2
	uses, tokens := int64(3), int64(4096)
	input := json.RawMessage(`{"command":"ls"}`)
	contents := []ContentBlock{
		{Type: ContentBlockText, Text: "before"},
		{Type: ContentBlockFile, File: &FileBlock{Name: "a.png", MIME: "image/png", Size: 10}},
	}
	authFailure := &AuthFailure{Agent: session.AgentTypeClaude, ProfileID: "p1"}
	usageLimit := &UsageLimit{Agent: session.AgentTypeCodex, ProfileID: ""}
	question := AskUserQuestion{
		Question: "Which?", Header: "Pick",
		Options:     []QuestionOption{{Label: "A", Description: "first", Recommended: true}, {Label: "B"}},
		MultiSelect: true,
	}
	answering := []QuestionAnswer{{
		RequestID: "q1", Header: "Pick", Question: "Which?", Answers: []string{"A"},
		Text: "and more", Note: "why", ResolvedBy: &QuestionResolver{Kind: ResolverAgent, WorkID: "w", Title: "t", SessionID: "s"},
		AnsweredAt: at,
	}}
	meta := &MessageMeta{
		WorkID: "w1", WorkType: "story", Title: "Story",
		Step:  &StepInfo{Current: 1, Total: 2},
		Child: &ChildInfo{ID: "c1", Title: "Child"},
		Story: &StoryInfo{ID: "s1", Title: "Watched"},
	}
	action := &htmlpage.Action{Page: "p1", Action: "go", Data: json.RawMessage(`{}`)}
	attachments := []FileBlock{{Name: "b.pdf", MIME: "application/pdf", Size: 20}}
	review := &PermissionReview{SessionID: "rev", Category: "destructive", Reason: "no"}
	steps := []PlanStep{{ID: "1", Text: "Do", ActiveText: "Doing", Status: PlanStepInProgress}}
	suggestions := []PermissionUpdate{{Type: PermissionUpdateAddRules, Behavior: PermissionBehaviorAllow,
		Destination: PermissionDestinationSession, Rules: []PermissionRuleValue{{ToolName: "Bash", RuleContent: "ls"}}}}

	return []wireCompatCase{
		{
			name: "text",
			wire: TextRecord{Content: "hi", ParentToolUseID: "parent", ProviderMessageID: "msg"},
			legacy: legacyEventRecord{Type: EventTypeText, Content: "hi", ParentToolUseID: "parent",
				ProviderMessageID: "msg"},
		},
		{
			name: "tool_call",
			wire: ToolCallRecord{ToolName: "Bash", ToolInput: input, ToolUseID: "t1", OriginToolUseID: "t0",
				ParentToolUseID: "parent", ObservedAt: &at, Subtype: ToolCallResumed, ProviderMessageID: "msg"},
			legacy: legacyEventRecord{Type: EventTypeToolCall, ToolName: "Bash", ToolInput: input, ToolUseID: "t1",
				OriginToolUseID: "t0", ParentToolUseID: "parent", ObservedAt: &at, Subtype: string(ToolCallResumed),
				ProviderMessageID: "msg"},
		},
		{
			name: "tool_result",
			wire: ToolResultRecord{ToolUseID: "t1", ParentToolUseID: "parent", ToolResult: "out", Contents: contents,
				IsError: true, ObservedAt: &at, Subtype: ToolResultBackgroundStarted, DurationMs: 1500, ExitCode: &exit,
				Subagent: &SubagentReport{AgentID: "a1", AgentType: "explore",
					SubagentCounts: SubagentCounts{ToolUses: &uses, TotalTokens: &tokens}},
				HTMLPage: "p2", WorkRef: &WorkRef{ID: "w1", Type: "task", Title: "Task"}, ProviderMessageID: "msg"},
			legacy: legacyEventRecord{Type: EventTypeToolResult, ToolUseID: "t1", ParentToolUseID: "parent",
				ToolResult: "out", Contents: contents, IsError: true, ObservedAt: &at,
				Subtype: string(ToolResultBackgroundStarted), DurationMs: 1500, ExitCode: &exit,
				Subagent: &SubagentReport{AgentID: "a1", AgentType: "explore",
					SubagentCounts: SubagentCounts{ToolUses: &uses, TotalTokens: &tokens}},
				HTMLPage: "p2", WorkRef: &WorkRef{ID: "w1", Type: "task", Title: "Task"}, ProviderMessageID: "msg"},
		},
		{
			name: "thinking",
			wire: ThinkingRecord{Content: "hmm", ParentToolUseID: "parent", DurationMs: 900, FullReasoning: "raw",
				Redacted: true, ProviderMessageID: "msg"},
			legacy: legacyEventRecord{Type: EventTypeThinking, Content: "hmm", ParentToolUseID: "parent",
				DurationMs: 900, FullReasoning: "raw", Redacted: true, ProviderMessageID: "msg"},
		},
		{
			name: "warning",
			wire: WarningRecord{Message: "careful", Code: "c", AuthFailure: authFailure, UsageLimit: usageLimit},
			legacy: legacyEventRecord{Type: EventTypeWarning, Message: "careful", Code: "c", AuthFailure: authFailure,
				UsageLimit: usageLimit},
		},
		{
			name: "error",
			wire: ErrorRecord{Error: "boom", AuthFailure: authFailure, UsageLimit: usageLimit, ObservedAt: &at},
			legacy: legacyEventRecord{Type: EventTypeError, Error: "boom", AuthFailure: authFailure,
				UsageLimit: usageLimit, ObservedAt: &at},
		},
		{
			name:   "done",
			wire:   DoneRecord{ObservedAt: &at},
			legacy: legacyEventRecord{Type: EventTypeDone, ObservedAt: &at},
		},
		{
			name:   "interrupted",
			wire:   InterruptedRecord{ObservedAt: &at},
			legacy: legacyEventRecord{Type: EventTypeInterrupted, ObservedAt: &at},
		},
		{
			name:   "process_ended",
			wire:   ProcessEndedRecord{ObservedAt: &at},
			legacy: legacyEventRecord{Type: EventTypeProcessEnded, ObservedAt: &at},
		},
		{
			name:   "process_ended a restarted server writes",
			wire:   ProcessEndedRecord{},
			legacy: legacyEventRecord{Type: EventTypeProcessEnded},
		},
		{
			name: "permission_request",
			wire: PermissionRequestRecord{ToolName: "Bash", ToolInput: input, ToolUseID: "t1", RequestID: "r1",
				PermissionSuggestions: suggestions, DecisionReason: "rule", BlockedPath: "/etc"},
			legacy: legacyEventRecord{Type: EventTypePermissionRequest, ToolName: "Bash", ToolInput: input,
				ToolUseID: "t1", RequestID: "r1", PermissionSuggestions: suggestions, DecisionReason: "rule",
				BlockedPath: "/etc"},
		},
		{
			name:   "request_cancelled",
			wire:   RequestCancelledRecord{RequestID: "r1", Reason: ReasonWorkClosed, ResolvedAt: &later},
			legacy: legacyEventRecord{Type: EventTypeRequestCancelled, RequestID: "r1", Reason: ReasonWorkClosed, ResolvedAt: &later},
		},
		{
			name:   "question_posted",
			wire:   QuestionPostedRecord{RequestID: "q1", Questions: []AskUserQuestion{question}, AskedAt: &at},
			legacy: legacyEventRecord{Type: EventTypeQuestionPosted, RequestID: "q1", Questions: []AskUserQuestion{question}, AskedAt: &at},
		},
		{
			name:   "system",
			wire:   SystemRecord{Content: `{"subtype":"init"}`},
			legacy: legacyEventRecord{Type: EventTypeSystem, Content: `{"subtype":"init"}`},
		},
		{
			name:   "background_wait",
			wire:   BackgroundWaitRecord{},
			legacy: legacyEventRecord{Type: EventTypeBackgroundWait},
		},
		{
			name: "message",
			wire: MessageRecord{Content: "do it", ObservedAt: &at, Answering: answering,
				Command: &CommandInvocation{Name: "pockode-lead", Args: "x"}, HTMLAction: action,
				Attachments: attachments, Origin: MessageOriginSystem, MessageID: "m1", Subtype: "kickoff", Meta: meta},
			legacy: legacyEventRecord{Type: EventTypeMessage, Content: "do it", ObservedAt: &at, Answering: answering,
				Command: &CommandInvocation{Name: "pockode-lead", Args: "x"}, HTMLAction: action,
				Attachments: attachments, Origin: MessageOriginSystem, MessageID: "m1", Subtype: "kickoff", Meta: meta},
		},
		{
			name:   "message_ingested",
			wire:   MessageIngestedRecord{ObservedAt: &at, MessageID: "m1"},
			legacy: legacyEventRecord{Type: EventTypeMessageIngested, ObservedAt: &at, MessageID: "m1"},
		},
		{
			name:   "message_discarded",
			wire:   MessageDiscardedRecord{MessageID: "m1"},
			legacy: legacyEventRecord{Type: EventTypeMessageDiscarded, MessageID: "m1"},
		},
		{
			name: "permission_response",
			wire: PermissionResponseRecord{RequestID: "r1", Choice: "deny", By: RespondedByPermissionReviewer,
				Review: review, ObservedAt: &at},
			legacy: legacyEventRecord{Type: EventTypePermissionResponse, RequestID: "r1", Choice: "deny",
				By: RespondedByPermissionReviewer, Review: review, ObservedAt: &at},
		},
		{
			name:   "raw",
			wire:   RawRecord{Content: "not json"},
			legacy: legacyEventRecord{Type: EventTypeRaw, Content: "not json"},
		},
		{
			name:   "command_output",
			wire:   CommandOutputRecord{Content: "ctx"},
			legacy: legacyEventRecord{Type: EventTypeCommandOutput, Content: "ctx"},
		},
		{
			name: "plan",
			wire: PlanRecord{ToolUseID: "t1", ParentToolUseID: "parent", Steps: steps, Explanation: "why",
				PlanID: "turn:plan:1", ProviderMessageID: "msg"},
			legacy: legacyEventRecord{Type: EventTypePlan, ToolUseID: "t1", ParentToolUseID: "parent", Steps: steps,
				Explanation: "why", PlanID: "turn:plan:1", ProviderMessageID: "msg"},
		},
		{
			name: "ask_user_question",
			wire: AskUserQuestionRecord{ToolUseID: "t1", RequestID: "r1",
				Questions: []AskUserQuestion{question, {Question: "Second?", Header: "Two"}}},
			legacy: legacyEventRecord{Type: EventTypeAskUserQuestion, ToolUseID: "t1", RequestID: "r1",
				Questions: []AskUserQuestion{question, {Question: "Second?", Header: "Two"}}},
		},
		{
			// The flat struct had no answers field, so the only legacy shape it
			// can stand for is a cancelled question's; the answered shape is
			// TestDecodeRecord_LegacyQuestionResponse's.
			name:   "question_response a CLI cancelled",
			wire:   QuestionResponseRecord{RequestID: "r1"},
			legacy: legacyEventRecord{Type: EventTypeQuestionResponse, RequestID: "r1"},
		},
		{
			name: "tool_activity",
			wire: ToolActivityLiveEvent{ToolUseID: "t1", Activity: "Reading", OutputDelta: "line\n",
				SubagentProgress: &SubagentProgress{SubagentCounts: SubagentCounts{ToolUses: &uses}, LastToolName: "Read"}},
			legacy: legacyEventRecord{Type: EventTypeToolActivity, ToolUseID: "t1", Activity: "Reading",
				OutputDelta:      "line\n",
				SubagentProgress: &SubagentProgress{SubagentCounts: SubagentCounts{ToolUses: &uses}, LastToolName: "Read"}},
		},
		{
			name:   "thinking_delta",
			wire:   ThinkingDeltaLiveEvent{ContentDelta: "a", FullReasoningDelta: "b"},
			legacy: legacyEventRecord{Type: EventTypeThinkingDelta, ContentDelta: "a", FullReasoningDelta: "b"},
		},
	}
}

// TestWire_WritesWhatTheFlatRecordWrote is the downgrade half of the contract:
// every line a server writes now is byte-for-byte the line a server from
// before the split would have written for the same event, so that server reads
// it — and so does every client — exactly as it always did.
func TestWire_WritesWhatTheFlatRecordWrote(t *testing.T) {
	for _, tc := range wireCompatCases() {
		t.Run(tc.name, func(t *testing.T) {
			got, err := json.Marshal(tc.wire)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			want, err := json.Marshal(tc.legacy)
			if err != nil {
				t.Fatalf("marshal legacy: %v", err)
			}
			if string(got) != string(want) {
				t.Errorf("wire differs from the flat record:\n got %s\nwant %s", got, want)
			}
		})
	}
}

// TestDecodeRecord_ReadsWhatTheFlatRecordWrote is the upgrade half: every line
// an older server wrote decodes into its type's record with nothing lost, and
// writes back out unchanged.
func TestDecodeRecord_ReadsWhatTheFlatRecordWrote(t *testing.T) {
	for _, tc := range wireCompatCases() {
		want, isRecord := tc.wire.(Record)
		if !isRecord {
			continue
		}
		t.Run(tc.name, func(t *testing.T) {
			line, err := json.Marshal(tc.legacy)
			if err != nil {
				t.Fatalf("marshal legacy: %v", err)
			}
			got, err := DecodeRecord(line)
			if err != nil {
				t.Fatalf("decode %s: %v", line, err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("decoded %#v, want %#v", got, want)
			}
			again, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("re-marshal: %v", err)
			}
			if string(again) != string(line) {
				t.Errorf("round trip changed the line:\n got %s\nwant %s", again, line)
			}
		})
	}
}

// bornAfterTheSplit are the types no server before the split could write, so
// the flat record has nothing to compare them with. Each is pinned by an
// ordinary round trip instead (TestDecodeRecord_RoundTripsTypesBornAfterTheSplit).
var bornAfterTheSplit = map[EventType]bool{
	EventTypeTurnStarted: true,
}

// TestWireCompatCases_CoverEveryType keeps the two tests above honest: a type
// added to wireTypes needs a case here before it can be trusted to be on the
// format, and has to be stored or live, never both.
func TestWireCompatCases_CoverEveryType(t *testing.T) {
	covered := make(map[EventType]bool)
	for typ := range bornAfterTheSplit {
		covered[typ] = true
	}
	for _, tc := range wireCompatCases() {
		if tc.wire.Type() != tc.legacy.Type {
			t.Errorf("case %q: wire type %q, legacy type %q", tc.name, tc.wire.Type(), tc.legacy.Type)
		}
		covered[tc.wire.Type()] = true
	}
	for _, w := range WireTypes() {
		if !covered[w.Type()] {
			t.Errorf("%T (%q) has no compatibility case", w, w.Type())
		}
		_, isRecord := w.(Record)
		_, isLive := w.(LiveEvent)
		if isRecord == isLive {
			t.Errorf("%T must be exactly one of Record and LiveEvent", w)
		}
	}
}

// TestDecodeRecord_LegacyQuestionResponse reads the answered shape of a record
// only the CLI's own blocking prompt ever wrote, as docs/agent-event.md
// describes it — a shape the flat struct could not express at all.
func TestDecodeRecord_LegacyQuestionResponse(t *testing.T) {
	line := `{"type":"question_response","request_id":"r1","answers":{"Which?":"A, B","Other":"mine"}}`
	got, err := DecodeRecord([]byte(line))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := QuestionResponseRecord{RequestID: "r1", Answers: map[string]string{"Which?": "A, B", "Other": "mine"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded %#v, want %#v", got, want)
	}
	again, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("re-marshal: %v", err)
	}
	var gotFields, wantFields map[string]any
	if err := json.Unmarshal(again, &gotFields); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(line), &wantFields); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotFields, wantFields) {
		t.Errorf("round trip changed the record:\n got %s\nwant %s", again, line)
	}
}

// TestDecodeRecord_IgnoresFieldsTheTypeDoesNotHave: a line can carry fields
// its type has no use for — the flat struct could set any field on any type,
// and a newer server may add one. They are ignored, as the flat struct ignored
// unknown ones, rather than failing the line.
func TestDecodeRecord_IgnoresFieldsTheTypeDoesNotHave(t *testing.T) {
	got, err := DecodeRecord([]byte(`{"type":"done","content":"stray","future_field":1,"seq":7}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !reflect.DeepEqual(got, DoneRecord{}) {
		t.Errorf("decoded %#v, want an empty DoneRecord", got)
	}
}

// TestDecodeRecord_KeepsASubtypeNoConstantNames: each record's subtype is a
// type of its own with a closed set of constants, but a newer server may add a
// value, and an older build has to keep it as written rather than drop or
// refuse it — or re-encoding the record (a fork's copy) would lose it.
func TestDecodeRecord_KeepsASubtypeNoConstantNames(t *testing.T) {
	for _, line := range []string{
		`{"type":"tool_call","tool_use_id":"t1","subtype":"future_kind"}`,
		`{"type":"tool_result","tool_use_id":"t1","subtype":"future_kind"}`,
		`{"type":"message","content":"hi","origin":"system","subtype":"future_kind"}`,
	} {
		rec, err := DecodeRecord([]byte(line))
		if err != nil {
			t.Fatalf("decode %s: %v", line, err)
		}
		got, err := json.Marshal(rec)
		if err != nil {
			t.Fatalf("marshal %s: %v", line, err)
		}
		if string(got) != line {
			t.Errorf("re-encoded as %s, want %s", got, line)
		}
	}
}

func TestDecodeRecord_RefusesWhatIsNotAKnownRecord(t *testing.T) {
	for _, line := range []string{
		`{"type":"tool_activity","tool_use_id":"t1"}`, // never stored
		`{"type":"from_a_newer_server"}`,
		`{"content":"no type"}`,
	} {
		if _, err := DecodeRecord([]byte(line)); !errors.Is(err, ErrUnknownRecordType) {
			t.Errorf("DecodeRecord(%s) = %v, want ErrUnknownRecordType", line, err)
		}
	}
	if _, err := DecodeRecord([]byte(`not json`)); err == nil || errors.Is(err, ErrUnknownRecordType) {
		t.Errorf("DecodeRecord(not json) = %v, want a parse error", err)
	}
}

// TestAgentEvent_EncodesAsItsOwnType: every event serializes under its own
// type, as a record when it is one the decoder reads back and as a live event
// otherwise — so what process persists and what a replay can decode are the
// same set.
func TestAgentEvent_EncodesAsItsOwnType(t *testing.T) {
	live := map[EventType]bool{EventTypeToolActivity: true, EventTypeThinkingDelta: true}
	events := []AgentEvent{
		TextEvent{}, ToolCallEvent{}, ToolResultEvent{}, ToolActivityEvent{}, ThinkingEvent{},
		ThinkingDeltaEvent{}, WarningEvent{}, ErrorEvent{}, DoneEvent{}, InterruptedEvent{},
		PermissionRequestEvent{}, RequestCancelledEvent{}, QuestionPostedEvent{}, SystemEvent{},
		BackgroundWaitEvent{}, ProcessEndedEvent{}, MessageEvent{}, MessageIngestedEvent{},
		MessageDiscardedEvent{}, PermissionResponseEvent{}, RawEvent{}, CommandOutputEvent{}, PlanEvent{},
	}
	for _, event := range events {
		wire := event.Encode()
		if wire.Type() != event.EventType() {
			t.Errorf("%T encodes as %q, want %q", event, wire.Type(), event.EventType())
		}
		_, isRecord := wire.(Record)
		_, isLive := wire.(LiveEvent)
		if isRecord == isLive {
			t.Errorf("%T encodes as %T, which must be exactly one of Record and LiveEvent", event, wire)
		}
		if isLive != live[event.EventType()] {
			t.Errorf("%T: live = %v, want %v", event, isLive, live[event.EventType()])
		}
		if _, decodable := recordTypes[event.EventType()]; decodable != isRecord {
			t.Errorf("%T is persisted = %v but decodable = %v", event, isRecord, decodable)
		}
	}
}

// TestDecodeRecord_RoundTripsTypesBornAfterTheSplit is the format of each type
// in bornAfterTheSplit, written down: the line it marshals to, and that the
// line decodes back to the same record.
func TestDecodeRecord_RoundTripsTypesBornAfterTheSplit(t *testing.T) {
	at := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		record Record
		line   string
	}{
		{
			TurnStartedRecord{TurnID: "t1", Origin: TurnOriginPrompt, MessageID: "m1", ObservedAt: &at},
			`{"type":"turn_started","turn_id":"t1","origin":"prompt","message_id":"m1","observed_at":"2026-11-28T12:00:00Z"}`,
		},
		{
			TurnStartedRecord{TurnID: "t2", Origin: TurnOriginOutput},
			`{"type":"turn_started","turn_id":"t2","origin":"output"}`,
		},
	}
	seen := make(map[EventType]bool)
	for _, tc := range cases {
		seen[tc.record.Type()] = true
		got, err := json.Marshal(tc.record)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if string(got) != tc.line {
			t.Errorf("line = %s, want %s", got, tc.line)
		}
		decoded, err := DecodeRecord([]byte(tc.line))
		if err != nil {
			t.Fatalf("decode %s: %v", tc.line, err)
		}
		if !reflect.DeepEqual(decoded, tc.record) {
			t.Errorf("decoded %#v, want %#v", decoded, tc.record)
		}
	}
	for typ := range bornAfterTheSplit {
		if !seen[typ] {
			t.Errorf("%q has no round-trip case", typ)
		}
	}
}
