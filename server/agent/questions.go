package agent

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pockode/server/session"
)

// UnansweredQuestions reads a run of history records and reports the posted
// questions still open at the end of it, oldest first.
//
// This is the one place a question's *state* is derived from records, and it
// exists for the one case that has no state to read: a fork. A fork is a new
// session holding a copy of a conversation, and what it must inherit is the
// questions that were unanswered at the point the copy was cut — which is not
// the same set as the ones unanswered in the source right now, and cannot be,
// because the source has gone on answering since. The records are the only
// account of that moment, so they are what is read.
//
// Everywhere else the unanswered list is state and is read off the session's
// turn (session.TurnState.Unanswered). Do not reach for this as a cheaper way
// to answer "is this question still open" — replaying a transcript to find out
// what is true now is exactly what AGENTS.md's "events are events, state is
// state" forbids, and it would go wrong the first time a question is resolved
// without a record reaching this history.
//
// A record that does not parse is skipped: it cannot name a question either
// way, and refusing to fork over one malformed line would be the larger harm.
func UnansweredQuestions(records []json.RawMessage) []session.PendingQuestion {
	var open []session.PendingQuestion
	drop := func(requestID string) (session.PendingQuestion, bool) {
		for i, q := range open {
			if q.RequestID == requestID {
				open = append(open[:i], open[i+1:]...)
				return q, true
			}
		}
		return session.PendingQuestion{}, false
	}
	// What each message answered, for a Stop that discards it before the agent
	// read it: the questions it took off the list are open again.
	answeredBy := make(map[string][]session.PendingQuestion)

	for _, raw := range records {
		var rec EventRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		switch rec.Type {
		case EventTypeQuestionPosted:
			if q, ok := pendingFromRecord(rec); ok {
				open = append(open, q)
			}
		case EventTypeMessage:
			// A message is the answer record: see QuestionAnswer.
			for _, answer := range rec.Answering {
				if q, ok := drop(answer.RequestID); ok && rec.MessageID != "" {
					answeredBy[rec.MessageID] = append(answeredBy[rec.MessageID], q)
				}
			}
		case EventTypeMessageDiscarded:
			open = append(open, answeredBy[rec.MessageID]...)
			delete(answeredBy, rec.MessageID)
		case EventTypeRequestCancelled:
			drop(rec.RequestID)
		}
	}
	return open
}

// pendingFromRecord rebuilds the live question a question_posted record was
// written from. A record with no request id or no question names nothing that
// could be answered, so it is not inherited.
func pendingFromRecord(rec EventRecord) (session.PendingQuestion, bool) {
	if rec.RequestID == "" || len(rec.Questions) == 0 {
		return session.PendingQuestion{}, false
	}
	q := rec.Questions[0]
	pending := session.PendingQuestion{
		RequestID:   rec.RequestID,
		Header:      q.Header,
		Question:    q.Question,
		Options:     SessionQuestionOptions(q.Options),
		MultiSelect: q.MultiSelect,
	}
	if rec.AskedAt != nil {
		pending.AskedAt = *rec.AskedAt
	}
	return pending, true
}

// SessionQuestionOptions converts the options of a question as an agent states
// them into the options as a session holds them. Two declarations of one shape,
// for the reason session.QuestionOption gives; this is the single crossing
// between them.
func SessionQuestionOptions(options []QuestionOption) []session.QuestionOption {
	if len(options) == 0 {
		return nil
	}
	out := make([]session.QuestionOption, len(options))
	for i, o := range options {
		out[i] = session.QuestionOption{Label: o.Label, Description: o.Description, Recommended: o.Recommended}
	}
	return out
}

// AgentQuestionOptions is the crossing in the other direction, for writing a
// live question back out as a record.
func AgentQuestionOptions(options []session.QuestionOption) []QuestionOption {
	if len(options) == 0 {
		return nil
	}
	out := make([]QuestionOption, len(options))
	for i, o := range options {
		out[i] = QuestionOption{Label: o.Label, Description: o.Description, Recommended: o.Recommended}
	}
	return out
}

// Describe names an answerer in a sentence: in the message an answer arrives
// in, in the refusal a second answer gets, and in what the work above the asker
// is told about it. A nil resolver is a record written before answerers were
// recorded, all of which were the user's.
func (r *QuestionResolver) Describe() string {
	if r == nil || r.Kind != ResolverAgent {
		return "the user"
	}
	if r.WorkID == "" {
		return "another agent"
	}
	if r.Title == "" {
		return fmt.Sprintf("the agent working on %s", r.WorkID)
	}
	return fmt.Sprintf("the agent working on %q (%s)", r.Title, r.WorkID)
}

func (r *QuestionResolver) possessive() string {
	if r != nil && r.Kind == ResolverAgent {
		return "its"
	}
	return "their"
}

// Line is the answer as an agent reads it, after "A:", wherever an agent is
// told one.
//
// A decline is written as a phrase rather than left blank, because a blank
// answer reads to the agent as "the user said nothing" — which is what it was
// already looking at before the message arrived.
//
// The answerer's own words are marked as such when they sit beside a label: the
// record keeps Answers and Text apart, but a CLI reads only this, and an
// unmarked sentence next to two labels would read as a third option the agent
// had offered. A lone free text carries no marker, deliberately: there is
// nothing beside it to be mistaken for, and every answer to a question with no
// options is that shape.
//
// The note is marked for the same reason, and always: unmarked after a label
// it would read as part of the label, and after a decline as a reason nobody
// can tell from an answer.
func (a QuestionAnswer) Line() string {
	var line string
	if a.Declined {
		line = "(not answering)"
	} else {
		parts := append([]string(nil), a.Answers...)
		if a.Text != "" {
			text := a.Text
			if len(a.Answers) > 0 {
				text = fmt.Sprintf("and, in %s own words: %s", a.ResolvedBy.possessive(), text)
			}
			parts = append(parts, text)
		}
		line = strings.Join(parts, " \u00b7 ")
	}
	if a.Note != "" {
		line += " — note: " + a.Note
	}
	return line
}

// SettledQuestion is a posted question that has stopped waiting, and how. It is
// what the session layer hands the work layer when that happens
// (chat.QuestionsSettledFunc), so that whoever was told a question was asked
// can be told it no longer is.
//
// It is an event, not state: it says how the question was settled at that
// moment, and is handed on and dropped. Whether a question is still waiting is
// the session's turn state, never this.
type SettledQuestion struct {
	Question session.PendingQuestion
	// Answer is the answer or the decline that settled it, nil when it was
	// withdrawn.
	Answer *QuestionAnswer
	// Reason is why it was withdrawn, meaningful only when Answer is nil: empty
	// when the asking agent withdrew it itself (question_cancel).
	Reason CancelReason
}
