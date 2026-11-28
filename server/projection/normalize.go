package projection

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/pockode/server/agent"
)

// fact is one thing a record says, in the shape the current version says it.
// Records enter the fold through normalize, which is the one place a shape an
// older Pockode or CLI wrote is read into today's: past it, the fold sees only
// facts, and no reader downstream has to know a legacy shape existed.
type fact interface{ isFact() }

type questionAsked struct{ question Question }

// questionAnswered is one entry of a message's answering list.
type questionAnswered struct {
	answer    agent.QuestionAnswer
	messageID string
}

// legacyAnswered is a question_response: the CLI's own questions answered in
// the old flat shape, one string per question keyed by question text, or nil
// when the CLI cancelled them. It is parsed against the questions it answers,
// which only the fold holds (settleLegacy).
type legacyAnswered struct {
	requestID string
	answers   map[string]string
}

type questionWithdrawn struct {
	requestID string
	reason    agent.CancelReason
	at        *time.Time
}

// messageSent carries the message itself, origin normalized, for the readers
// of messages to come (the tool-run items and the wire); no State field reads
// it yet.
type messageSent struct{ message agent.MessageRecord }

type messageDiscarded struct {
	messageID string
	excerpt   string
}

type messageRead struct {
	messageID string
	at        *time.Time
}

type planStated struct{ plan agent.PlanRecord }

func (questionAsked) isFact()     {}
func (questionAnswered) isFact()  {}
func (legacyAnswered) isFact()    {}
func (questionWithdrawn) isFact() {}
func (messageSent) isFact()       {}
func (messageDiscarded) isFact()  {}
func (messageRead) isFact()       {}
func (planStated) isFact()        {}

// legacyWorkOrigin is the origin system messages were recorded with before the
// concept was renamed (agent.MessageOriginSystem). Untyped on purpose: a
// constant of type agent.MessageOrigin would be read as a value the wire can
// carry (agent/wirets), and nothing writes this one any more.
const legacyWorkOrigin = "work"

// legacyDiscardedCode and legacyDiscardedLead are the warning a Stop wrote for
// a message it discarded before message_discarded existed: it named no
// message, only quoted it after the lead.
const (
	legacyDiscardedCode = "message_discarded"
	legacyDiscardedLead = "Stopping the turn discarded a message the agent had not read yet, so it will not be answered: "
)

// normalize is what rec says, as facts. Records that say nothing this fold
// keeps say nothing.
func normalize(rec agent.Record) []fact {
	switch rec := rec.(type) {
	case agent.ToolCallRecord:
		rec.ToolInput = normalizeToolInput(rec.ToolName, rec.ToolInput)
		return []fact{toolCalled{call: rec}}

	case agent.ToolResultRecord:
		return []fact{toolReturned{result: rec}}

	case agent.PermissionRequestRecord:
		rec.ToolInput = normalizeToolInput(rec.ToolName, rec.ToolInput)
		return []fact{permissionAsked{request: rec}}

	case agent.PermissionResponseRecord:
		return []fact{permissionAnswered{response: rec}}

	case agent.ProcessEndedRecord:
		return []fact{processEnded{}}

	case agent.QuestionPostedRecord:
		if rec.RequestID == "" || len(rec.Questions) == 0 {
			// Names nothing that could be answered.
			return nil
		}
		return []fact{questionAsked{question: askedQuestion(rec.RequestID, rec.Questions[0], rec.AskedAt)}}

	case agent.AskUserQuestionRecord:
		facts := make([]fact, 0, len(rec.Questions))
		for _, q := range rec.Questions {
			question := askedQuestion(rec.RequestID, q, nil)
			question.Legacy, question.ToolUseID = true, rec.ToolUseID
			facts = append(facts, questionAsked{question: question})
		}
		return facts

	case agent.QuestionResponseRecord:
		return []fact{legacyAnswered{requestID: rec.RequestID, answers: rec.Answers}}

	case agent.MessageRecord:
		if string(rec.Origin) == legacyWorkOrigin {
			rec.Origin = agent.MessageOriginSystem
		}
		facts := []fact{messageSent{message: rec}}
		for _, a := range rec.Answering {
			facts = append(facts, questionAnswered{answer: a, messageID: rec.MessageID})
		}
		return facts

	case agent.RequestCancelledRecord:
		return []fact{
			questionWithdrawn{requestID: rec.RequestID, reason: rec.Reason, at: rec.ResolvedAt},
			permissionWithdrawn{requestID: rec.RequestID, reason: rec.Reason},
		}

	case agent.MessageDiscardedRecord:
		return []fact{messageDiscarded{messageID: rec.MessageID}}

	case agent.WarningRecord:
		if rec.Code != legacyDiscardedCode {
			return nil
		}
		return []fact{messageDiscarded{excerpt: strings.TrimPrefix(rec.Message, legacyDiscardedLead)}}

	case agent.MessageIngestedRecord:
		return []fact{messageRead{messageID: rec.MessageID, at: rec.ObservedAt}}

	case agent.PlanRecord:
		return []fact{planStated{plan: rec}}
	}
	return nil
}

func askedQuestion(requestID string, q agent.AskUserQuestion, at *time.Time) Question {
	return Question{
		RequestID:   requestID,
		Header:      q.Header,
		Question:    q.Question,
		Options:     q.Options,
		MultiSelect: q.MultiSelect,
		AskedAt:     at,
	}
}

// The flat answer of the CLI's own question: labels joined by ", ", with an
// optional trailing "Other: <free text>". The client read it the same way
// before this did (web/src/utils/questionAnswer.ts).
const (
	legacyOtherPrefix = "Other: "
	legacySeparator   = ", "
)

// lookupLegacyAnswer finds one question's entry in a question_response's map.
// The map was keyed by question text; the header and, for a record of one
// question with one entry, that entry are the degradations a record nobody
// can fix still deserves.
func lookupLegacyAnswer(q Question, answers map[string]string, questionCount int) (string, bool) {
	if a, ok := answers[q.Question]; ok {
		return a, true
	}
	if a, ok := answers[q.Header]; ok {
		return a, true
	}
	if questionCount == 1 && len(answers) == 1 {
		for _, a := range answers {
			return a, true
		}
	}
	return "", false
}

// parseLegacyAnswer splits a flat answer back into the labels picked and the
// answerer's own words. Splitting on ", " is not safe — labels may hold
// commas and free text nearly always does — so known labels are consumed from
// the front, longest first, and whatever follows "Other: " or is not a label
// is the answerer's own words, so nothing they wrote is lost.
func parseLegacyAnswer(answer string, options []agent.QuestionOption) (labels []string, text string) {
	if answer == "" {
		return nil, ""
	}
	// An exact label is that option, even one the loop would read otherwise.
	for _, o := range options {
		if o.Label == answer {
			return []string{answer}, ""
		}
	}

	rest := answer
	for rest != "" {
		if strings.HasPrefix(rest, legacyOtherPrefix) {
			return labels, strings.TrimPrefix(rest, legacyOtherPrefix)
		}
		matched := ""
		for _, o := range options {
			if o.Label == "" || !strings.HasPrefix(rest, o.Label) {
				continue
			}
			after := rest[len(o.Label):]
			if after != "" && !strings.HasPrefix(after, legacySeparator) {
				continue
			}
			if len(o.Label) > len(matched) {
				matched = o.Label
			}
		}
		if matched == "" {
			return labels, rest
		}
		labels = append(labels, matched)
		rest = strings.TrimPrefix(rest[len(matched):], legacySeparator)
	}
	return labels, ""
}

// codexPatchTool is the name a Codex patch is recorded under, the one tool
// whose input the client reads either shape of changes from
// (agent/codex buildEditInput).
const codexPatchTool = "Edit"

// normalizeToolInput reads a Codex patch's input into the one shape of its
// changes, the app-server channel's array of {path, kind: {type, move_path},
// diff}. Records written before Pockode moved to that channel hold the MCP
// channel's map of path to {type, content | unified_diff, move_path}; it
// carries the same facts under other names, and is rewritten into the array,
// in path order. Only the changes are rewritten: every other byte of the input
// stays as recorded. Every other input, and a map with an entry it cannot
// read — which the client draws as the raw input — is left whole.
func normalizeToolInput(toolName string, input json.RawMessage) json.RawMessage {
	if toolName != codexPatchTool {
		return input
	}
	from, to, ok := topLevelValue(input, "changes")
	if !ok || input[from] != '{' {
		return input
	}
	var legacy map[string]struct {
		Type        *string `json:"type"`
		Content     string  `json:"content"`
		UnifiedDiff string  `json:"unified_diff"`
		MovePath    *string `json:"move_path"`
	}
	if json.Unmarshal(input[from:to], &legacy) != nil {
		return input
	}
	type kind struct {
		Type     string  `json:"type"`
		MovePath *string `json:"move_path,omitempty"`
	}
	type change struct {
		Path string `json:"path"`
		Kind kind   `json:"kind"`
		Diff string `json:"diff"`
	}
	changes := make([]change, 0, len(legacy))
	for path, c := range legacy {
		if c.Type == nil {
			return input
		}
		entry := change{Path: path, Kind: kind{Type: *c.Type}, Diff: c.Content}
		if *c.Type == "update" {
			entry.Kind.MovePath, entry.Diff = c.MovePath, c.UnifiedDiff
		}
		changes = append(changes, entry)
	}
	slices.SortFunc(changes, func(a, b change) int { return strings.Compare(a.Path, b.Path) })

	// Without json.Marshal's HTML escaping: a diff is full of <, > and &.
	var buf bytes.Buffer
	buf.Write(input[:from])
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(changes) != nil {
		return input
	}
	buf.Truncate(buf.Len() - 1) // Encode's newline
	buf.Write(input[to:])
	return buf.Bytes()
}

// topLevelValue is where the value of key sits in a JSON object, as byte
// offsets: the last one, as decoding reads a repeated key.
func topLevelValue(input json.RawMessage, key string) (from, to int, found bool) {
	dec := json.NewDecoder(bytes.NewReader(input))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return 0, 0, false
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return 0, 0, false
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return 0, 0, false
		}
		if tok == key {
			end := int(dec.InputOffset())
			from, to, found = end-len(value), end, true
		}
	}
	return from, to, found
}
