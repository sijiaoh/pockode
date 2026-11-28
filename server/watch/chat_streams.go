package watch

import (
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/projection"
	"github.com/pockode/server/rpc"
)

// maxStreamOutput bounds the output kept for one call in flight. Only a
// subscriber arriving mid-call, or one that lost a delta, is sent what is
// kept; the whole output arrives with the call's result either way. A
// megabyte is far more than a screen shows, and small next to the result
// that will carry the same bytes.
const maxStreamOutput = 1 << 20

// thinkingStream is the key a subscriber's lost deltas are kept under for the
// thinking stream; a call's is its tool_use_id, which is never empty.
const thinkingStream = ""

// chatStreams are a session's live streams: what chat.delta has said since
// each began. A stream begins with its first delta and ends with the update
// that settles it (settle) — never on a raw record: what the transcript says
// of an item is the projection's to say.
//
// Text is kept in buffers that grow by amortized appends: a stream is
// thousands of small deltas, and a string rebuilt per delta would copy the
// whole stream each time. The text is copied out only when somebody needs
// all of it — a subscriber's snapshot, or one that lost a delta.
type chatStreams struct {
	thinking *thinkingBuffer
	tools    map[string]*toolBuffer
}

type thinkingBuffer struct {
	content, fullReasoning strings.Builder
}

func (b *thinkingBuffer) view() rpc.ThinkingStream {
	return rpc.ThinkingStream{Content: b.content.String(), FullReasoning: b.fullReasoning.String()}
}

type toolBuffer struct {
	activity  string
	output    []byte
	truncated bool
	progress  *agent.SubagentProgress
}

// appendOutput keeps between maxStreamOutput and twice that of the newest
// output, trimming the front once it reaches twice: each byte is copied a
// bounded number of times however long the call prints.
func (b *toolBuffer) appendOutput(delta string) {
	b.output = append(b.output, delta...)
	if len(b.output) >= 2*maxStreamOutput {
		b.output = append([]byte(nil), b.output[len(b.output)-maxStreamOutput:]...)
		b.truncated = true
	}
}

func (b *toolBuffer) view() rpc.ToolStream {
	out := rpc.ToolStream{Activity: b.activity, OutputTruncated: b.truncated}
	output := b.output
	if len(output) > maxStreamOutput {
		output, out.OutputTruncated = output[len(output)-maxStreamOutput:], true
	}
	if out.OutputTruncated {
		output = fromCharacter(output)
	}
	out.Output = string(output)
	if b.progress != nil {
		progress := *b.progress
		out.SubagentProgress = &progress
	}
	return out
}

func (s *chatStreams) empty() bool {
	return s.thinking == nil && len(s.tools) == 0
}

// snapshot is a copy of the streams; the zero value for a nil s.
func (s *chatStreams) snapshot() rpc.ChatStreams {
	var out rpc.ChatStreams
	if s == nil {
		return out
	}
	if s.thinking != nil {
		t := s.thinking.view()
		out.Thinking = &t
	}
	if len(s.tools) > 0 {
		out.Tools = make(map[string]rpc.ToolStream, len(s.tools))
		for id, t := range s.tools {
			out.Tools[id] = t.view()
		}
	}
	return out
}

// streamsEnded are the streams an update settled.
type streamsEnded struct {
	Thinking bool     `json:"thinking,omitempty"`
	Tools    []string `json:"tools,omitempty"`
}

// settle ends the streams u settles and says which, nil for none:
//
//   - the thinking stream, with the main agent's next item of its own — the
//     thinking item that records it, or text written without one — or with
//     any change of turn, since thinking does not outlive its turn;
//   - a call's, once its item is no longer in flight: settled, refused or
//     expired. A call in the background is still in flight;
//   - and with a turn's end, every call's but those in the background, which
//     background says. A call the turn left running is interrupted by an
//     ending that cut it short, and nothing reports on one after a turn that
//     completed; and a stream can name a call no item is for (an engine's
//     progress line with an id of its own), which no item will ever settle.
func (s *chatStreams) settle(u projection.Update, background map[string]bool) *streamsEnded {
	var ended streamsEnded
	end := func(id string) {
		delete(s.tools, id)
		ended.Tools = append(ended.Tools, id)
	}
	endThinking := len(u.Turns) > 0
	for _, it := range u.Items {
		item := it.Item
		switch item.Kind {
		case projection.KindThinking:
			endThinking = endThinking || (it.Parent == 0 && item.Thinking.ParentToolUseID == "")
		case projection.KindText:
			endThinking = endThinking || (it.Parent == 0 && item.Text.ParentToolUseID == "")
		case projection.KindTool:
			id := item.Tool.ToolUseID
			if _, ok := s.tools[id]; ok && !inFlight(item.Tool.Status) {
				end(id)
			}
		}
	}
	if endsTurn(u) {
		for id := range s.tools {
			if !background[id] {
				end(id)
			}
		}
	}
	slices.Sort(ended.Tools)
	if endThinking && s.thinking != nil {
		s.thinking = nil
		ended.Thinking = true
	}
	if !ended.Thinking && len(ended.Tools) == 0 {
		return nil
	}
	return &ended
}

func endsTurn(u projection.Update) bool {
	for _, turn := range u.Turns {
		if turn.Turn.Ended {
			return true
		}
	}
	return false
}

func inFlight(status projection.ItemStatus) bool {
	switch status {
	case projection.ItemRunning, projection.ItemBackground, projection.ItemAwaitingPermission:
		return true
	}
	return false
}

// deltaParams is a chat.delta: the subscription id for routing, and the
// stream it extends — exactly one of Thinking and Tool.
type deltaParams struct {
	ID       string         `json:"id"`
	Thinking *thinkingDelta `json:"thinking,omitempty"`
	Tool     *toolDelta     `json:"tool,omitempty"`
}

// thinkingDelta extends the thinking stream: Content and FullReasoning are
// appended to what the client has — or, with Replace, are the whole stream
// so far, sent in place of the next piece after the subscriber missed one.
type thinkingDelta struct {
	Content       string `json:"content,omitempty"`
	FullReasoning string `json:"full_reasoning,omitempty"`
	Replace       bool   `json:"replace,omitempty"`
}

// toolDelta extends the stream of the call ToolUseID names, which is the
// tool item it belongs to. Output is appended, or with Replace is the whole
// output kept so far (rpc.ToolStream.Output, truncated as OutputTruncated
// says); Activity and SubagentProgress are latest values, each replacing the
// last whenever present.
type toolDelta struct {
	ToolUseID        string                  `json:"tool_use_id"`
	Activity         string                  `json:"activity,omitempty"`
	Output           string                  `json:"output,omitempty"`
	OutputTruncated  bool                    `json:"output_truncated,omitempty"`
	SubagentProgress *agent.SubagentProgress `json:"subagent_progress,omitempty"`
	Replace          bool                    `json:"replace,omitempty"`
}

// sessionStreams is the session's streams, made on first use. Caller holds
// sessionMu.
func (w *ChatMessagesWatcher) sessionStreams(sessionID string) *chatStreams {
	st, ok := w.streams[sessionID]
	if !ok {
		st = &chatStreams{tools: map[string]*toolBuffer{}}
		w.streams[sessionID] = st
	}
	return st
}

// thinkingDelta extends the session's thinking stream, beginning it if need
// be. Caller holds sessionMu.
func (w *ChatMessagesWatcher) thinkingDelta(sessionID string, ev agent.ThinkingDeltaLiveEvent) {
	st := w.sessionStreams(sessionID)
	if st.thinking == nil {
		st.thinking = &thinkingBuffer{}
	}
	st.thinking.content.WriteString(ev.ContentDelta)
	st.thinking.fullReasoning.WriteString(ev.FullReasoningDelta)
	thinking := st.thinking
	w.offerDelta(sessionID, thinkingStream,
		func(id string) deltaParams {
			return deltaParams{ID: id, Thinking: &thinkingDelta{Content: ev.ContentDelta, FullReasoning: ev.FullReasoningDelta}}
		},
		func(id string) deltaParams {
			whole := thinking.view()
			return deltaParams{ID: id, Thinking: &thinkingDelta{Content: whole.Content, FullReasoning: whole.FullReasoning, Replace: true}}
		})
}

// toolDelta extends the stream of the call the event names, beginning it if
// need be. Caller holds sessionMu.
func (w *ChatMessagesWatcher) toolDelta(sessionID string, ev agent.ToolActivityLiveEvent) {
	if ev.ToolUseID == "" {
		return
	}
	st := w.sessionStreams(sessionID)
	t, ok := st.tools[ev.ToolUseID]
	if !ok {
		t = &toolBuffer{}
		st.tools[ev.ToolUseID] = t
	}
	if ev.Activity != "" {
		t.activity = ev.Activity
	}
	if ev.SubagentProgress != nil {
		progress := *ev.SubagentProgress
		t.progress = &progress
	}
	t.appendOutput(ev.OutputDelta)
	w.offerDelta(sessionID, ev.ToolUseID,
		func(id string) deltaParams {
			return deltaParams{ID: id, Tool: &toolDelta{
				ToolUseID:        ev.ToolUseID,
				Activity:         ev.Activity,
				Output:           ev.OutputDelta,
				SubagentProgress: ev.SubagentProgress,
			}}
		},
		func(id string) deltaParams {
			whole := t.view()
			return deltaParams{ID: id, Tool: &toolDelta{
				ToolUseID:        ev.ToolUseID,
				Activity:         whole.Activity,
				Output:           whole.Output,
				OutputTruncated:  whole.OutputTruncated,
				SubagentProgress: whole.SubagentProgress,
				Replace:          true,
			}}
		})
}

// offerDelta queues a delta of the stream key names for every subscriber of
// the session. A delta is the first thing turned away from a subscriber that
// falls behind (chatSubscriber.offer); one that lost a piece of a stream is
// sent the whole stream in place of its next piece, so a stream it is sent is
// never one with a hole in it. Caller holds sessionMu.
func (w *ChatMessagesWatcher) offerDelta(sessionID, key string, piece, whole func(id string) deltaParams) {
	for _, sub := range w.sessionToSub[sessionID] {
		params := piece
		if sub.gaps[key] {
			// The whole stream is a copy of all of it: not built for a
			// subscriber that would only turn it away again.
			if sub.refusesDroppable() {
				continue
			}
			params = whole
		}
		if sub.offer(Notification{Method: ChatDeltaMethod, Params: params(sub.id)}, true) {
			delete(sub.gaps, key)
		} else {
			sub.gaps[key] = true
		}
	}
}

// forgetGaps drops what subscribers lost of streams that have ended: the
// item that settled each holds the whole of it. Caller holds sessionMu.
func (w *ChatMessagesWatcher) forgetGaps(sessionID string, ended *streamsEnded) {
	for _, sub := range w.sessionToSub[sessionID] {
		if ended.Thinking {
			delete(sub.gaps, thinkingStream)
		}
		for _, id := range ended.Tools {
			delete(sub.gaps, id)
		}
	}
}

// fromCharacter is b from its first whole character: output cut at a byte
// count can start inside one.
func fromCharacter(b []byte) []byte {
	for i := 0; i < len(b) && i < utf8.UTFMax; i++ {
		if utf8.RuneStart(b[i]) {
			return b[i:]
		}
	}
	return b
}
