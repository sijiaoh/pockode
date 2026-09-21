package agent

import (
	"encoding/json"

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
	drop := func(requestID string) {
		for i, q := range open {
			if q.RequestID == requestID {
				open = append(open[:i], open[i+1:]...)
				return
			}
		}
	}

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
				drop(answer.RequestID)
			}
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
		out[i] = session.QuestionOption{Label: o.Label, Description: o.Description}
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
		out[i] = QuestionOption{Label: o.Label, Description: o.Description}
	}
	return out
}
