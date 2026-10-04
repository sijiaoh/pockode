package codex

import (
	"encoding/json"
	"strings"

	"github.com/pockode/server/agent"
)

// reasoningSummary is the summary Pockode asks Codex for, as a config override
// (`model_reasoning_summary`, config.toml's key). Without one a reasoning item
// completes with an empty summary and no summary deltas are sent (measured on
// codex-cli 0.160.0, whose app-server default leaves it out), so every thinking
// row would be a bare duration. "auto" lets the model pick the detail, which is
// what Codex's own TUI shows.
const reasoningSummary = "auto"

// partSeparator joins the parts of a reasoning item's summary or content, both
// in the record and between the deltas that build it live.
const partSeparator = "\n\n"

// reasoningProgress is what is known about a reasoning item still in flight.
type reasoningProgress struct {
	// thread is the thread the item belongs to, whose turn ending is what
	// forgets it.
	thread string
	// startedAtMs is the engine's own clock reading from item/started; zero if
	// that was never seen.
	startedAtMs int64
	// summaryPart and contentPart are the part the last delta of each list
	// belonged to, which is how a delta that opens a new part knows to carry
	// the separator.
	summaryPart, contentPart int64
}

// reasoning returns the progress of an item, starting one for an item first
// seen mid-flight.
func (s *appSession) reasoning(itemID, thread string) *reasoningProgress {
	if s.reasoningItems == nil {
		s.reasoningItems = map[string]*reasoningProgress{}
	}
	p, ok := s.reasoningItems[itemID]
	if !ok {
		p = &reasoningProgress{thread: thread}
		s.reasoningItems[itemID] = p
	}
	return p
}

// forgetReasoning drops the items of the threads whose turn has ended: what an
// interrupt cut off never completes (see handleReasoningCompleted), and a
// subagent's turn is not over when its parent's is.
func (s *appSession) forgetReasoning(ended func(thread string) bool) {
	for id, p := range s.reasoningItems {
		if ended(p.thread) {
			delete(s.reasoningItems, id)
		}
	}
}

// handleReasoningStarted remembers when a reasoning item began, which is half
// of its duration, and says the main agent is thinking before any of its text
// arrives — a summary can take seconds to start, and has none at all when the
// model writes none.
func (s *appSession) handleReasoningStarted(item threadItem) {
	s.reasoning(item.ID, item.ThreadID).startedAtMs = item.AtMs
	if !item.FromSubagent {
		s.emitEvent(agent.ThinkingDeltaEvent{})
	}
}

// handleReasoningCompleted records a finished reasoning item as a thinking.
//
// An interrupted turn completes no item for the reasoning it cut off (measured
// on codex-cli 0.160.0: turn/completed with status interrupted, no
// item/completed), so that reasoning leaves no record — the same live and on
// replay.
func (s *appSession) handleReasoningCompleted(item threadItem) {
	var ev struct {
		Summary []string `json:"summary"`
		Content []string `json:"content"`
	}
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		s.log.Warn("failed to parse reasoning item", "error", err)
		return
	}

	var durationMs int64
	if p, ok := s.reasoningItems[item.ID]; ok {
		delete(s.reasoningItems, item.ID)
		// Both readings are the engine's, so the phone's and the server's
		// clocks never enter into it. Never zero once measured: zero is how
		// the record says it was not.
		if p.startedAtMs > 0 && item.AtMs >= p.startedAtMs {
			durationMs = max(item.AtMs-p.startedAtMs, 1)
		}
	}

	s.emitEvent(agent.ThinkingEvent{
		Content:           strings.Join(ev.Summary, partSeparator),
		FullReasoning:     strings.Join(ev.Content, partSeparator),
		DurationMs:        durationMs,
		ParentToolUseID:   item.ParentToolUseID,
		ProviderMessageID: item.TurnID,
	})
}

// handleReasoningDelta forwards the next piece of the main agent's reasoning
// text while it is being written; full selects the raw reasoning
// (item/reasoning/textDelta) over the summary (item/reasoning/summaryTextDelta).
//
// A subagent's is dropped: its row describes its work, and the main agent's
// tail line must not say the main agent is thinking when it is waiting.
func (s *appSession) handleReasoningDelta(params json.RawMessage, full bool) {
	var notif struct {
		ThreadID     string `json:"threadId"`
		ItemID       string `json:"itemId"`
		Delta        string `json:"delta"`
		SummaryIndex int64  `json:"summaryIndex"`
		ContentIndex int64  `json:"contentIndex"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse a reasoning delta", "error", err)
		return
	}
	if !s.isOwnThread(notif.ThreadID) || notif.ItemID == "" || notif.Delta == "" {
		return
	}

	// The separator goes on the first delta of a new part, once per part
	// boundary crossed, so the deltas concatenate into exactly the text the
	// record joins — including a part that received no deltas of its own.
	p := s.reasoning(notif.ItemID, notif.ThreadID)
	part, index := &p.summaryPart, notif.SummaryIndex
	if full {
		part, index = &p.contentPart, notif.ContentIndex
	}
	delta := notif.Delta
	if index > *part {
		delta = strings.Repeat(partSeparator, int(index-*part)) + delta
		*part = index
	}

	if full {
		s.emitEvent(agent.ThinkingDeltaEvent{FullReasoningDelta: delta})
	} else {
		s.emitEvent(agent.ThinkingDeltaEvent{ContentDelta: delta})
	}
}
