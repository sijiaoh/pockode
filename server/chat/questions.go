package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// ErrQuestionNotPending is returned when a request id names no question this
// session is still waiting on an answer to. The error text says what became of
// it when the transcript can say — see describeResolution.
var ErrQuestionNotPending = errors.New("that question is not waiting for an answer")

// ErrAnswerShape is returned when an answer is neither an answer nor a
// decline, or picks options the question did not offer. It is a boundary check:
// the agent is told what it was answered, and an answer nobody could have
// chosen would be a lie in its transcript.
var ErrAnswerShape = errors.New("invalid answer")

// Answer is one question a message answers, as the sender stated it.
//
// An answer is either Declined or has something in Answers or Text. All three
// empty is the case that makes the distinction worth enforcing: it would record
// a question as answered with nothing, which reads to the agent as "the user
// said nothing" rather than as "the user has not said anything yet".
type Answer struct {
	RequestID string
	// Answers are option labels the question offered. Every one of them is
	// checked against the question, which is what keeps the agent from being
	// told it was handed back a choice it never gave.
	Answers []string
	// Text is what the user wrote themselves: the whole answer to a question
	// with no options, or the "Other" beside ones it had. Checked against
	// nothing — it is the user's own words, not a choice.
	Text     string
	Declined bool
	// Note is the answerer's optional line beside what they answered: a
	// remark on a pick ("Postgres, but pin it to 16"), or the reason beside a
	// decline. It never stands in for an answer, so validateAnswer allows it
	// only where there is one to sit beside and it cannot be mistaken for one.
	Note string
}

// Questions is the half of Client the question tools reach. It exists so that
// the MCP executor — which has no session store of its own and gets here
// through the worktree manager — depends on what it uses rather than on the
// whole chat client.
type Questions interface {
	// PostQuestions records questions on behalf of the agent running in
	// sessionID and returns them as the session now holds them — the request
	// ids an answer will name, and the questions themselves, which is what a
	// story above this session is told about them. They come back in the order
	// they were given, and on error hold the ones that were posted before it.
	PostQuestions(ctx context.Context, sessionID string, specs []QuestionSpec) ([]session.PendingQuestion, error)
	// CancelQuestion withdraws a question the same agent posted.
	CancelQuestion(ctx context.Context, sessionID, requestID string) error
	// AnswerQuestion delivers an answer an agent gave to a question this
	// session is waiting on. sessionID is the session that *asked*, which is
	// not the one the answering agent runs in.
	AnswerQuestion(ctx context.Context, sessionID string, answer Answer, by agent.QuestionResolver) error
}

// QuestionSpec is a question as an agent asks it: everything but the id, which
// is the server's to hand out.
type QuestionSpec struct {
	Header      string
	Question    string
	Options     []session.QuestionOption
	MultiSelect bool
}

// PostQuestions records questions asked together and starts waiting for their
// answers.
//
// Asking together changes how the questions arrive and nothing else: each is
// its own question, with its own request id and its own question_posted
// record, answered, declined and withdrawn on its own. They share one AskedAt
// because they were asked at one moment, and their order is the order they
// are written in — the transcript's and the session's unanswered list, which
// is appended to and never re-sorted — so nothing beside them needs to carry
// it.
//
// For each question the record goes in first and the state second, and that
// order is the whole shape of this: the transcript gains a fact that never
// changes, and the session's turn gains a list entry that disappears the moment
// someone answers. A record written with no state behind it shows as a
// question nobody is waiting on — visible, wrong, and repairable. State with no
// record behind it would be a question with no account of having been asked,
// which a fork could not inherit and a transcript could not explain.
//
// Two calls in one session — a model can make them in parallel — are taken
// one at a time, so a batch is never split by another's questions landing in
// the middle of it.
//
// A failure part way stops there and returns what was already posted: those
// questions are being asked, and the caller has to be able to say so.
//
// No process is started and none is needed: the agent asking is by definition
// running, and a question outlives whatever process asked it anyway.
func (c *Client) PostQuestions(ctx context.Context, sessionID string, specs []QuestionSpec) ([]session.PendingQuestion, error) {
	if _, found, err := c.store.Get(sessionID); err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	} else if !found {
		return nil, ErrSessionNotFound
	}

	c.postMu.Lock()
	defer c.postMu.Unlock()

	now := time.Now()
	posted := make([]session.PendingQuestion, 0, len(specs))
	for _, spec := range specs {
		q, err := c.postQuestion(ctx, sessionID, spec, now)
		if err != nil {
			return posted, err
		}
		posted = append(posted, q)
	}
	return posted, nil
}

func (c *Client) postQuestion(ctx context.Context, sessionID string, spec QuestionSpec, now time.Time) (session.PendingQuestion, error) {
	q := session.PendingQuestion{
		RequestID:   uuid.Must(uuid.NewV7()).String(),
		Header:      spec.Header,
		Question:    spec.Question,
		Options:     spec.Options,
		MultiSelect: spec.MultiSelect,
		AskedAt:     now,
	}

	record := agent.NewEventRecord(agent.QuestionPostedEvent{
		RequestID: q.RequestID,
		Question: agent.AskUserQuestion{
			Question:    q.Question,
			Header:      q.Header,
			Options:     agent.AgentQuestionOptions(q.Options),
			MultiSelect: q.MultiSelect,
		},
		AskedAt: now,
	})
	seq, err := c.store.AppendToHistory(ctx, sessionID, record)
	if err != nil {
		// Refused rather than degraded, unlike a message: a message is worth
		// answering whether or not the transcript kept it, but a question the
		// transcript never heard cannot be inherited by a fork and cannot be
		// explained to whoever is asked to answer it.
		return session.PendingQuestion{}, fmt.Errorf("record question: %w", err)
	}

	if _, err := c.store.ApplyTurn(ctx, sessionID, session.TurnInput{
		Signal: session.SignalQuestionPosted, Question: &q, At: now,
	}); err != nil {
		return session.PendingQuestion{}, fmt.Errorf("record that the session is waiting for an answer: %w", err)
	}

	c.broadcastRecord(sessionID, record, seq)
	slog.Info("question posted", "sessionId", sessionID, "requestId", q.RequestID)
	return q, nil
}

// CancelQuestion withdraws a question that is still waiting for an answer.
//
// Nothing is sent anywhere: a withdrawal is the agent saying it no longer needs
// the answer, and there is nobody to tell but the user, who learns it from the
// card going quiet. That is the difference from a decline, which is a person
// answering "I will not answer this" and does reach the agent.
func (c *Client) CancelQuestion(ctx context.Context, sessionID, requestID string) error {
	return c.withdraw(ctx, sessionID, requestID, "")
}

// WithdrawQuestions takes back every question a session is still waiting on,
// with a reason. It is what a work closing does to the questions beneath it:
// nobody is coming back to answer them, and a question left pending on a
// finished work is one the user can never clear.
func (c *Client) WithdrawQuestions(ctx context.Context, sessionID string, reason agent.CancelReason) {
	meta, found, err := c.store.Get(sessionID)
	if err != nil || !found {
		return
	}
	for _, q := range meta.Turn.Unanswered {
		if err := c.withdraw(ctx, sessionID, q.RequestID, reason); err != nil {
			slog.Warn("failed to withdraw a question",
				"sessionId", sessionID, "requestId", q.RequestID, "reason", reason, "error", err)
		}
	}
}

func (c *Client) withdraw(ctx context.Context, sessionID, requestID string, reason agent.CancelReason) error {
	meta, found, err := c.store.Get(sessionID)
	if err != nil {
		return fmt.Errorf("get session: %w", err)
	}
	if !found {
		return ErrSessionNotFound
	}
	if _, pending := meta.Turn.PendingQuestionFor(requestID); !pending {
		return c.notPending(ctx, sessionID, requestID)
	}

	now := time.Now()
	record := agent.NewEventRecord(agent.RequestCancelledEvent{
		RequestID: requestID, Reason: reason, At: now,
	})
	seq, err := c.store.AppendToHistory(ctx, sessionID, record)
	if err != nil {
		return fmt.Errorf("record withdrawal: %w", err)
	}
	if _, err := c.store.ApplyTurn(ctx, sessionID, session.TurnInput{
		Signal: session.SignalQuestionResolved, RequestID: requestID, At: now,
	}); err != nil {
		return fmt.Errorf("stop waiting for the answer: %w", err)
	}

	c.broadcastRecord(sessionID, record, seq)
	slog.Info("question withdrawn", "sessionId", sessionID, "requestId", requestID, "reason", reason)
	return nil
}

// SendAnswers sends a message that answers posted questions, and is the only
// way a person answers one. It returns the message body alongside the seq.
//
// The message body is written here, from the answers, rather than taken from
// the client: it is the only half of an answer the agent reads, and an agent's
// answer arrives in the same shape (see answerMessage), so the wording has one
// home. The sender is left out of the broadcast carrying the record, so the
// body is handed back for it to learn what the agent read.
//
// Every answer is checked before anything is delivered, and one bad answer
// refuses the whole message. The content is a single string written for all of
// them together, so there is no half of it to deliver: a message split down to
// the questions that still needed answering would reach the agent as prose
// answering questions it has already had answers to.
//
// The questions leave the unanswered list only once the agent has the message.
// A send that failed handed it nothing, and a question cleared for a message
// nobody received is one the user is no longer offered and the agent is still
// waiting on.
//
// Two clients answering the same question at the same instant can therefore
// both be accepted: the checks read the list before the send and clear it
// after. Deliberately not locked. The cost is that the agent reads one question
// answered twice, which is a thing it can make sense of; the alternative is
// holding the session's state across a write to a subprocess's stdin, for a
// race that needs two people answering one question in the same breath.
func (c *Client) SendAnswers(ctx context.Context, sessionID string, answers []Answer, exclude any) (session.HistorySeq, string, error) {
	return c.deliverAnswers(ctx, sessionID, answers, agent.UserResolver(), exclude)
}

// AnswerQuestion delivers one answer an agent gave to a question another
// session asked, and is question_answer's whole effect on the session that
// asked.
//
// It is the path a person's answer takes, deliberately: the same checks in the
// same order, the same record, the same prose, the same removal from the
// unanswered list. An answer that took a second path would be a second set of
// rules about what an answer may be, and the transcript would hold two shapes
// of the same fact. Only who answered differs, and answerMessage says so.
//
// It returns once the answer is with the agent, which can mean starting its
// process first: a question outlives the process that asked it, so the
// commonest target is a session whose CLI was collected minutes ago. The tool
// waits for that rather than reporting a delivery it has not made.
//
// An agent answers; it never declines. Refusing to answer is a person's to do —
// it is them saying they will not be drawn — and an agent that does not know the
// answer simply leaves the question where it is, for the user or for another
// agent. So question_answer offers no decline.
func (c *Client) AnswerQuestion(ctx context.Context, sessionID string, answer Answer, by agent.QuestionResolver) error {
	_, _, err := c.deliverAnswers(ctx, sessionID, []Answer{answer}, by, nil)
	return err
}

// deliverAnswers is the one path an answer takes, whoever gave it, and returns
// the body the agent was sent.
func (c *Client) deliverAnswers(ctx context.Context, sessionID string, answers []Answer, by agent.QuestionResolver, exclude any) (session.HistorySeq, string, error) {
	if len(answers) == 0 {
		// A body with no answers in it would be a bare "Answering:" that starts
		// a turn about nothing.
		return session.NoHistorySeq, "", fmt.Errorf("%w: a message answering questions has to answer at least one", ErrAnswerShape)
	}
	meta, found, err := c.store.Get(sessionID)
	if err != nil {
		return session.NoHistorySeq, "", fmt.Errorf("get session: %w", err)
	}
	if !found {
		return session.NoHistorySeq, "", ErrSessionNotFound
	}

	now := time.Now()
	answering, err := c.resolveAnswers(ctx, sessionID, meta.Turn, answers, by, now)
	if err != nil {
		return session.NoHistorySeq, "", err
	}

	content := answerMessage(answering, by)
	seq, err := c.sendEvent(ctx, sessionID, agent.MessageEvent{
		Content: content, Answering: answering, Origin: originOf(by),
	}, exclude)
	if err != nil {
		return seq, "", err
	}

	for _, a := range answering {
		if _, err := c.store.ApplyTurn(ctx, sessionID, session.TurnInput{
			Signal: session.SignalQuestionResolved, RequestID: a.RequestID, At: now,
		}); err != nil {
			// The agent has the answer; the list is what is behind. Worth
			// shouting about — the question stays on screen and answering it
			// again is refused by nothing — but not worth failing a send that
			// landed.
			slog.Error("answered question left on the unanswered list",
				"sessionId", sessionID, "requestId", a.RequestID, "error", err)
		}
	}
	return seq, content, nil
}

// originOf says how a message carrying these answers is marked.
//
// A person's answer stays unmarked, as every message a person sends is: origin
// is what tells Pockode's own messages and another agent's apart from theirs,
// and an empty origin has meant "the user" in every transcript ever written.
func originOf(by agent.QuestionResolver) agent.MessageOrigin {
	if by.Kind == agent.ResolverAgent {
		return agent.MessageOriginAgent
	}
	return ""
}

// answerMessage is the body of the message answers arrive as, whoever gave
// them, and the one place that wording lives.
//
// The prose is the whole of what the receiving agent reads — `answering` is
// Pockode's own structure and never reaches a CLI — so it has to stand on its
// own: a bare option label would arrive as an answer to nothing, so each
// answer carries its question with it.
//
// The lead says who answered. A person's is one word, so that one question and
// five read the same (docs/answering-ui.md §3). An agent's names the agent and
// says it was not the user: without that the answer is indistinguishable from
// the user's own, and an agent acting on "the user chose Postgres" when no user
// has seen the question is the one failure question_answer could cause. Below
// the lead the two are the same shape, because they are the same fact.
func answerMessage(answering []agent.QuestionAnswer, by agent.QuestionResolver) string {
	var b strings.Builder
	if by.Kind == agent.ResolverAgent {
		fmt.Fprintf(&b, "Answering — from %s, not from the user.\n", describeResolver(&by))
	} else {
		b.WriteString("Answering:\n")
	}
	for _, a := range answering {
		fmt.Fprintf(&b, "\nQ: %s\nA: %s\n", a.Question, answerLine(a, by))
	}
	return strings.TrimRight(b.String(), "\n")
}

// answerLine is what follows "A:".
//
// A decline is written as a phrase rather than left blank, because a blank
// answer reads to the agent as "the user said nothing" — which is what it was
// already looking at before the message arrived.
//
// The answerer's own words are marked as such when they sit beside a label: the
// record keeps `answers` and `text` apart, but the CLI reads only this, and an
// unmarked sentence next to two labels would read as a third option the agent
// had offered. A lone free text carries no marker, deliberately: there is
// nothing beside it to be mistaken for, and every answer to a question with no
// options is that shape.
//
// The note is marked for the same reason, and always: unmarked after a label
// it would read as part of the label, and after a decline as a reason nobody
// can tell from an answer.
func answerLine(a agent.QuestionAnswer, by agent.QuestionResolver) string {
	var line string
	if a.Declined {
		line = "(not answering)"
	} else {
		parts := append([]string(nil), a.Answers...)
		if a.Text != "" {
			text := a.Text
			if len(a.Answers) > 0 {
				text = fmt.Sprintf("and, in %s own words: %s", possessive(by), text)
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

func possessive(by agent.QuestionResolver) string {
	if by.Kind == agent.ResolverAgent {
		return "its"
	}
	return "their"
}

// describeResolver names an answerer in a sentence, for the message an answer
// arrives in and for the refusal a second answer gets.
func describeResolver(by *agent.QuestionResolver) string {
	if by == nil || by.Kind != agent.ResolverAgent {
		return "the user"
	}
	if by.WorkID == "" {
		return "another agent"
	}
	if by.Title == "" {
		return fmt.Sprintf("the agent working on %s", by.WorkID)
	}
	return fmt.Sprintf("the agent working on %q (%s)", by.Title, by.WorkID)
}

// resolveAnswers checks every answer against the questions the session is
// actually waiting on and fills in what the record needs, or reports what is
// wrong with them.
//
// Two passes, and the order is the point. Every answer is checked for "is this
// question still open" first, and all the failures of that kind are reported
// together — a client showing four answers needs to know in one go which of
// them to grey out. Only then are the surviving answers checked for shape. The
// other order lets a typo in one answer hide a question somebody else resolved,
// which costs the client a whole extra round trip to find out.
//
// Resolved questions are listed in the order the client sent them, so the same
// refusal reads the same way twice.
func (c *Client) resolveAnswers(ctx context.Context, sessionID string, turn session.TurnState, answers []Answer, by agent.QuestionResolver, now time.Time) ([]agent.QuestionAnswer, error) {
	seen := make(map[string]struct{}, len(answers))
	var settled []string
	for _, a := range answers {
		if _, dup := seen[a.RequestID]; dup {
			return nil, fmt.Errorf("%w: request %s is answered twice in one message", ErrAnswerShape, a.RequestID)
		}
		seen[a.RequestID] = struct{}{}
		if _, pending := turn.PendingQuestionFor(a.RequestID); !pending {
			settled = append(settled, a.RequestID)
		}
	}
	if len(settled) > 0 {
		return nil, c.settledError(ctx, sessionID, settled)
	}

	out := make([]agent.QuestionAnswer, 0, len(answers))
	for _, a := range answers {
		q, _ := turn.PendingQuestionFor(a.RequestID)
		if err := validateAnswer(q, a); err != nil {
			return nil, err
		}
		out = append(out, agent.QuestionAnswer{
			RequestID:  q.RequestID,
			Header:     q.Header,
			Question:   q.Question,
			Answers:    a.Answers,
			Text:       strings.TrimSpace(a.Text),
			Declined:   a.Declined,
			Note:       strings.TrimSpace(a.Note),
			ResolvedBy: &by,
			AnsweredAt: now,
		})
	}
	return out, nil
}

// validateAnswer checks an answer's shape against the question it answers.
//
// What is enforced is that the *agent* is told the truth. A label has to be one
// the question offered, because a label it never offered would read in its
// transcript as its own word handed back to it. Free text is under no such
// rule: it is the user's own words, recorded as such (QuestionAnswer.Text), and
// the agent can see which is which. The thing being guarded is "do not invent
// an option", not "the user may not say anything else".
func validateAnswer(q session.PendingQuestion, a Answer) error {
	if err := validateAnswerShape(q, a); err != nil {
		return err
	}
	return validateNote(q, a)
}

func validateAnswerShape(q session.PendingQuestion, a Answer) error {
	text := strings.TrimSpace(a.Text)
	if a.Declined {
		if len(a.Answers) > 0 || text != "" {
			return fmt.Errorf("%w: %q is both answered and declined", ErrAnswerShape, q.Header)
		}
		return nil
	}
	// Whitespace-only text is not an answer. It would record the question as
	// answered with nothing, which is the one thing "declined" exists to say
	// properly.
	if len(a.Answers) == 0 && text == "" {
		return fmt.Errorf("%w: %q was answered with nothing; say something, or decline it", ErrAnswerShape, q.Header)
	}
	if len(q.Options) == 0 {
		// A question that offered nothing to pick can only be answered in the
		// user's own words, so a label here names an option that never existed.
		if len(a.Answers) > 0 {
			return fmt.Errorf("%w: %q offered no options, so %q is not one of them; answer it as text", ErrAnswerShape, q.Header, a.Answers[0])
		}
		return nil
	}
	// Free text counts towards the one answer a single-select question takes:
	// the user saying "none of these, it is X" is one answer, and an option
	// *and* a sentence would be two to a question that asked for one.
	picked := len(a.Answers)
	if text != "" {
		picked++
	}
	if !q.MultiSelect && picked > 1 {
		return fmt.Errorf("%w: %q takes one answer, got %d", ErrAnswerShape, q.Header, picked)
	}
	for _, label := range a.Answers {
		if !offersLabel(q.Options, label) {
			return fmt.Errorf("%w: %q does not offer %q", ErrAnswerShape, q.Header, label)
		}
	}
	return nil
}

// validateNote checks the note against what it sits beside.
//
// A decline takes one: it is the reason. An answer takes one only where it
// cannot be confused with the answer itself — beside picked options, which are
// the agent's words and leave the answerer none of their own. A question with
// no options is answered in the answerer's own words already, and so is a
// single-select question answered with Other; a note there would be a second
// sentence of the same kind, and the agent could not tell which one was the
// answer. On a multi-select question Other is one more item in a list rather
// than the answer itself, so the note remarks on the list, as it does there
// without Other.
//
// The "nothing chosen" case never reaches here: validateAnswerShape refuses an
// answer with nothing in it, so a note always has something beside it.
func validateNote(q session.PendingQuestion, a Answer) error {
	if a.Declined || strings.TrimSpace(a.Note) == "" {
		return nil
	}
	if len(q.Options) == 0 {
		return fmt.Errorf("%w: %q offered no options, so its answer is already in your own words and takes no note; put everything in the answer", ErrAnswerShape, q.Header)
	}
	if !q.MultiSelect && strings.TrimSpace(a.Text) != "" {
		return fmt.Errorf("%w: %q was answered in your own words (Other), which takes no note on a question with one answer; put everything in that answer", ErrAnswerShape, q.Header)
	}
	return nil
}

func offersLabel(options []session.QuestionOption, label string) bool {
	for _, o := range options {
		if o.Label == label {
			return true
		}
	}
	return false
}

// settledError explains, for each request that is no longer pending, what
// became of it.
func (c *Client) settledError(ctx context.Context, sessionID string, requestIDs []string) error {
	resolutions := c.readResolutions(ctx, sessionID, requestIDs)
	parts := make([]string, 0, len(requestIDs))
	for _, id := range requestIDs {
		parts = append(parts, fmt.Sprintf("%s (%s)", id, describeResolution(resolutions[id])))
	}
	return fmt.Errorf("%w: %s", ErrQuestionNotPending, strings.Join(parts, "; "))
}

func (c *Client) notPending(ctx context.Context, sessionID, requestID string) error {
	res := c.readResolutions(ctx, sessionID, []string{requestID})[requestID]
	return fmt.Errorf("%w: %s (%s)", ErrQuestionNotPending, requestID, describeResolution(res))
}

// resolution is what the transcript says became of a question.
type resolution struct {
	// Kind is "answered", "declined", "withdrawn" or "" when nothing in the
	// history names this request at all.
	Kind string
	// By is who answered, as a sentence names them: the user, or the agent that
	// answered for them. Read off the record (QuestionAnswer.ResolvedBy) rather
	// than inferred from Kind, which stopped being possible when an agent could
	// answer — see describeResolver.
	By string
	At time.Time
	// Reason is the withdrawal's reason, empty when the agent gave none.
	Reason agent.CancelReason
}

func describeResolution(r resolution) string {
	if r.Kind == "" {
		// Either it was never asked in this session, or it was asked by a build
		// that did not record the resolution. Saying which is not possible, and
		// guessing would be worse than the honest answer.
		return "it is not one of this session's open questions"
	}
	when := "at an unknown time"
	if !r.At.IsZero() {
		when = "at " + r.At.Format(time.RFC3339)
	}
	switch r.Kind {
	case "withdrawn":
		if r.Reason != "" {
			return fmt.Sprintf("withdrawn by the agent %s: %s", when, r.Reason)
		}
		return "withdrawn by the agent " + when
	default:
		return fmt.Sprintf("%s by %s %s", r.Kind, r.By, when)
	}
}

// readResolutions walks the session's transcript for what became of each of
// these requests.
//
// This is the one read of records that is allowed to be about a question's
// fate, and it is not a second source of truth: whether a question is *still
// open* has already been answered, by the turn state, and the only reason to be
// here is that the answer was no. What became of it afterwards is a fact about
// the past, which is exactly what a record is for.
//
// A failure to read the history is not a failure to refuse: the caller is
// already refusing, and the worst this can cost is a vaguer sentence.
func (c *Client) readResolutions(ctx context.Context, sessionID string, requestIDs []string) map[string]resolution {
	out := make(map[string]resolution, len(requestIDs))
	wanted := make(map[string]struct{}, len(requestIDs))
	for _, id := range requestIDs {
		wanted[id] = struct{}{}
	}

	records, err := c.store.GetHistory(ctx, sessionID)
	if err != nil {
		slog.Warn("could not read history to explain a resolved question",
			"sessionId", sessionID, "error", err)
		return out
	}

	// Backwards: the newest account of a request is the one that holds.
	for i := len(records) - 1; i >= 0 && len(wanted) > 0; i-- {
		var rec agent.EventRecord
		if err := json.Unmarshal(records[i], &rec); err != nil {
			continue
		}
		switch rec.Type {
		case agent.EventTypeMessage:
			for _, a := range rec.Answering {
				if _, want := wanted[a.RequestID]; !want {
					continue
				}
				kind := "answered"
				if a.Declined {
					kind = "declined"
				}
				out[a.RequestID] = resolution{Kind: kind, By: describeResolver(a.ResolvedBy), At: a.AnsweredAt}
				delete(wanted, a.RequestID)
			}
		case agent.EventTypeRequestCancelled:
			if _, want := wanted[rec.RequestID]; !want {
				continue
			}
			res := resolution{Kind: "withdrawn", Reason: rec.Reason}
			if rec.ResolvedAt != nil {
				res.At = *rec.ResolvedAt
			}
			out[rec.RequestID] = res
			delete(wanted, rec.RequestID)
		}
	}
	return out
}

func (c *Client) broadcastRecord(sessionID string, record agent.EventRecord, seq session.HistorySeq) {
	if c.broadcast != nil {
		c.broadcast(sessionID, record, seq, nil)
	}
}
