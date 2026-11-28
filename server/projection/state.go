package projection

import (
	"slices"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// State is what a history's records say, as far as they have been folded.
// Every slice is in history order.
type State struct {
	Turns []Turn
	// Items are the session's tool runs, one per call, in the order they
	// first appeared.
	Items []Item
	// Questions are every question asked in the session, posted or the CLI's
	// own (Question.Legacy), in the order they were asked.
	Questions []Question
	// Plan is the session's current plan: its newest main-thread plan record.
	// Nil for a session that never stated one.
	Plan *Plan
	// Discarded are the messages a Stop threw away unread.
	Discarded []DiscardedMessage
	// ReadPoints are the points the agent read a message sent while its turn
	// ran (agent.MessageIngestedRecord).
	ReadPoints []ReadPoint

	// unanswered are the request ids of the posted questions still open, in
	// the order they were put on the list — the order
	// session.TurnState.Unanswered keeps, which puts a question a discard
	// reopened at the end.
	unanswered []string
	// taskPlan is the newest main-thread plan that came out of a Claude call
	// (PlanRecord.ToolUseID), which is what a plan seed is read from.
	taskPlan *Plan
}

// Turn is one turn of the session, as its turn_started record and its ending
// say.
//
// It is the turn a page's items are grouped under (PageTurn), as it stands
// now, whichever page its items are on.
type Turn struct {
	ID        string           `json:"turn_id"`
	Origin    agent.TurnOrigin `json:"origin"`
	MessageID string           `json:"message_id,omitempty"`
	StartedAt *time.Time       `json:"started_at,omitempty"`
	// StartSeq is the seq of the turn_started record; NoHistorySeq for a turn
	// inferred from lines written before turns had ids, whose turn_started is
	// in no file.
	StartSeq session.HistorySeq `json:"start_seq,omitempty"`
	// Ended says an ending of this turn was recorded. A turn the next
	// turn_started follows with no ending between — its process died with the
	// server and nothing said so — stays not ended; it is just not the open
	// one (State.OpenTurn).
	Ended   bool                `json:"ended"`
	Outcome session.TurnOutcome `json:"outcome,omitempty"`
	// EndedBy is the signal that ended it, which says more than Outcome: an
	// aborted turn was interrupted, or lost its process.
	EndedBy session.TurnSignal `json:"ended_by,omitempty"`
	// EndSeq is the seq of the record that ended the turn.
	EndSeq session.HistorySeq `json:"end_seq,omitempty"`
	// EndedAt is the moment that record carries.
	EndedAt *time.Time `json:"ended_at,omitempty"`
}

// QuestionStatus is where a question stands.
type QuestionStatus string

const (
	QuestionOpen      QuestionStatus = "open"
	QuestionAnswered  QuestionStatus = "answered"
	QuestionDeclined  QuestionStatus = "declined"
	QuestionWithdrawn QuestionStatus = "withdrawn"
)

// Question is one question and what became of it.
type Question struct {
	RequestID   string                 `json:"request_id"`
	Header      string                 `json:"header,omitempty"`
	Question    string                 `json:"question"`
	Options     []agent.QuestionOption `json:"options,omitempty"`
	MultiSelect bool                   `json:"multi_select,omitempty"`
	AskedAt     *time.Time             `json:"asked_at,omitempty"`
	// TurnID is the turn the question was asked in, "" for none.
	TurnID string             `json:"-"`
	Seq    session.HistorySeq `json:"-"`
	// Legacy marks the CLI's own blocking question (ask_user_question), from
	// transcripts written before Pockode stopped letting a CLI ask one. One
	// record could carry several, so several share a request id. Nothing can
	// answer one any more, so an open one is not unanswered (State.Unanswered).
	Legacy    bool   `json:"legacy,omitempty"`
	ToolUseID string `json:"tool_use_id,omitempty"`

	Status QuestionStatus `json:"status"`
	// Answer is the answer or decline, for those statuses. A legacy answer is
	// parsed back out of the flat shape it was recorded in, and carries no
	// answerer or moment.
	Answer *agent.QuestionAnswer `json:"answer,omitempty"`
	// AnsweredIn is the message the answer went out in.
	AnsweredIn string `json:"answered_in,omitempty"`
	// DiscardedAnswer is the answer a Stop threw away unread, which reopened
	// the question, and DiscardedIn the message it went out in: what the
	// question's card still shows of it until the question is answered again
	// or withdrawn.
	DiscardedAnswer *agent.QuestionAnswer `json:"discarded_answer,omitempty"`
	DiscardedIn     string                `json:"discarded_in,omitempty"`
	// Reason and ResolvedAt are a withdrawal's.
	Reason     agent.CancelReason `json:"reason,omitempty"`
	ResolvedAt *time.Time         `json:"resolved_at,omitempty"`
}

// Plan is a plan record and where it sits.
type Plan struct {
	Record agent.PlanRecord
	Seq    session.HistorySeq
	TurnID string
}

// DiscardedMessage is a message a Stop threw away before the agent read it.
type DiscardedMessage struct {
	// MessageID names the message; empty for a discard recorded before the
	// message_discarded record existed, as a warning that named no message.
	MessageID string `json:"message_id,omitempty"`
	// Excerpt is what such a warning quoted of the message, as it quoted it;
	// empty for every discard that names its message.
	Excerpt string             `json:"excerpt,omitempty"`
	Seq     session.HistorySeq `json:"seq,omitempty"`
	// TurnID is the turn the Stop ended.
	TurnID string `json:"-"`
}

// ReadPoint is the point the agent read a message.
type ReadPoint struct {
	MessageID  string
	ObservedAt *time.Time
	Seq        session.HistorySeq
	TurnID     string
}

// OpenTurn is the id of the turn the history leaves open, "" when it leaves
// none: what a fork cut here ends with a process_ended of its own.
func (s State) OpenTurn() string {
	if n := len(s.Turns); n > 0 && !s.Turns[n-1].Ended {
		return s.Turns[n-1].ID
	}
	return ""
}

// Unanswered are the posted questions still open, in the order the session's
// unanswered list holds them (session.TurnState.Unanswered): what a fork cut
// here inherits.
func (s State) Unanswered() []session.PendingQuestion {
	if len(s.unanswered) == 0 {
		return nil
	}
	posted := make(map[string]Question, len(s.unanswered))
	for _, q := range s.Questions {
		if !q.Legacy {
			posted[q.RequestID] = q
		}
	}
	out := make([]session.PendingQuestion, 0, len(s.unanswered))
	for _, id := range s.unanswered {
		q, ok := posted[id]
		if !ok {
			continue
		}
		pending := session.PendingQuestion{
			RequestID:   q.RequestID,
			Header:      q.Header,
			Question:    q.Question,
			Options:     agent.SessionQuestionOptions(q.Options),
			MultiSelect: q.MultiSelect,
		}
		if q.AskedAt != nil {
			pending.AskedAt = *q.AskedAt
		}
		out = append(out, pending)
	}
	return out
}

// Posted is the question_post question requestID names.
func (s State) Posted(requestID string) (Question, bool) {
	for _, q := range s.Questions {
		if q.RequestID == requestID && !q.Legacy {
			return q, true
		}
	}
	return Question{}, false
}

// PlanSeed is the agent.StartOptions.PlanSeed the history holds: the steps of
// its newest main-thread plan that came out of a Claude call, when that plan is
// a snapshot of the Claude adapter's Task-tool fold. Nil otherwise — no such
// plan, or one that is a TodoWrite list, which has no task ids to seed a fold
// with.
func (s State) PlanSeed() []agent.PlanStep {
	if s.taskPlan == nil {
		return nil
	}
	for _, step := range s.taskPlan.Record.Steps {
		if step.ID == "" {
			return nil
		}
	}
	// A copy: the plan itself is shared with the fold (clone).
	return slices.Clone(s.taskPlan.Record.Steps)
}

// clone shares nothing the fold changes in place. Entries a fold replaces
// rather than edits — a question's answer, a plan — are shared.
func (s State) clone() State {
	s.Turns = append([]Turn(nil), s.Turns...)
	s.Items = cloneItems(s.Items)
	s.Questions = append([]Question(nil), s.Questions...)
	s.Discarded = append([]DiscardedMessage(nil), s.Discarded...)
	s.ReadPoints = append([]ReadPoint(nil), s.ReadPoints...)
	s.unanswered = append([]string(nil), s.unanswered...)
	return s
}
