package session

import "time"

// QuestionOption is one answer a question offers.
//
// It is the same shape as agent.QuestionOption and deliberately a second
// declaration rather than a shared one: the session package sits below agent and
// cannot import it, and the question a *session* is holding is not the question
// an agent CLI raised — one is Pockode's own state, the other is a frame parsed
// out of a subprocess. The conversion is one line, in the one place that posts a
// question (chat.Client.PostQuestion).
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// PendingQuestion is one question a session is waiting on an answer to.
//
// It is *state*, and it lives in TurnState because that is where the answer to
// "what is this session waiting for" is kept. The matching record in the
// transcript (agent.QuestionPostedEvent) is the immutable half of the same
// event: the record says a question was asked and never changes, this says the
// question is still open and disappears the moment it is not.
//
// Everything here is copied from the record rather than resolved from it,
// because the two answer different questions and a list that had to be rebuilt
// from the transcript on every read would be a list derived from history — see
// the "events are events, state is state" rule in AGENTS.md. The one place the
// derivation is run is a fork, which has no state to inherit and only the copied
// records to go on.
type PendingQuestion struct {
	// RequestID is the server's own id for this question, and what an answer
	// names. One question, one id: "decline this one" needs a subject.
	RequestID string `json:"request_id"`
	// Header is the short label a card and a chip are drawn with.
	Header string `json:"header"`
	// Question is the question itself, in the agent's words.
	Question string `json:"question"`
	// Options are the answers offered. Empty means free text.
	Options []QuestionOption `json:"options,omitempty"`
	// MultiSelect allows more than one option to be picked. Meaningless without
	// options, and refused there rather than silently ignored (see the
	// question_post tool).
	MultiSelect bool `json:"multi_select,omitempty"`
	// AskedAt is when the question was posted, which is what orders the list
	// (oldest first) and what a card prints.
	AskedAt time.Time `json:"asked_at"`
}
