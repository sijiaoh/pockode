package agent

import (
	"fmt"
	"strings"

	"github.com/pockode/server/session"
)

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
