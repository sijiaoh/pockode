// Package projection folds a session's history records into the state they
// describe: its turns, its tool runs, its questions and what became of them,
// its current plan, the messages a Stop discarded and the points the agent
// read the others.
//
// It is the state layer between the log and its readers. A record says what
// was true at one moment and never changes; what is true *now* of the things
// records talk about is derived here, by one pure fold, rather than by each
// reader replaying the records its own way.
//
// The fold is a function of the records alone, so it can be run over any
// prefix of a history — a fork reads the questions still unanswered at its cut
// that way — and folding a prefix and then appending the rest is the same as
// folding everything at once. It lives in memory only.
//
// What it does not own: live turn state is session.ReduceTurn's, and the
// projection reads the turns that rule recorded (the turn tags and turn_started
// records, or for lines written before turns had ids, agent.InferHistoryTurns'
// replay of that same rule) rather than deciding turns itself.
//
// Turn ids are per session. A fork's copy keeps its source's turn ids, so
// nothing here is ever keyed across sessions: a Projection is one session's.
package projection

import (
	"encoding/json"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// Projection is the fold of one session's history, kept current as records
// are appended. Not safe for concurrent use: the owner of the session's
// history serializes Append with its readers.
type Projection struct {
	inference *agent.TurnInference
	state     State

	// openTurn is the index in state.Turns of the turn the history leaves
	// open, -1 for none.
	openTurn int
	// questions indexes state.Questions by request id. A legacy
	// ask_user_question carried several questions under one id.
	questions map[string][]int
	// delivered are, by message id, the questions a message answered that
	// the agent may not have read yet; a discard of that message reopens
	// them. The turn ending lets go of them (session.TurnState.Delivered).
	delivered map[string][]string
	// items indexes state.Items.
	items itemIndex
	// settledIn is, by tool use id, how many turns had started when the run
	// settled: a subagent's call trailing in before the next turn begins has
	// nothing left to report on it.
	settledIn map[string]int
	// t is the transcript the records make: what a chat draws, item by item
	// (Page).
	t transcript
	// settled is the copy read as if nothing follows (settledView), kept
	// until the next append: a history read off a file can end on a message
	// waiting on the record after it, and every read of it until that record
	// arrives would otherwise copy the whole projection again.
	settled *Projection
}

// New is the projection of an empty history of a session run by agentType,
// which is what turns are inferred by for lines written before they had ids
// (agent.InferHistoryTurns).
func New(agentType session.AgentType) *Projection {
	return &Projection{
		inference: agent.NewTurnInference(agentType),
		openTurn:  -1,
		questions: map[string][]int{},
		delivered: map[string][]string{},
		items:     newItemIndex(),
		settledIn: map[string]int{},
		t:         newTranscript(),
	}
}

// Fold is the projection of records, a history as session.Reader.GetHistory
// returns it.
func Fold(records []json.RawMessage, agentType session.AgentType) *Projection {
	p := New(agentType)
	p.Append(records...)
	return p
}

// Append folds the records written after the ones already folded, oldest
// first.
func (p *Projection) Append(records ...json.RawMessage) {
	p.settled = nil
	var lines []agent.InferredLine
	for _, raw := range records {
		p.push(raw)
		lines = p.inference.Push(lines[:0], raw)
		for _, line := range lines {
			p.fold(line)
		}
	}
}

// AppendWritten is Append for a record this server has just written
// (agent.TurnInference.PushWritten): a message is folded as it lands instead
// of with the record after it, which is what lets a live update carry it.
func (p *Projection) AppendWritten(raw json.RawMessage) {
	p.settled = nil
	p.push(raw)
	for _, line := range p.inference.PushWritten(nil, raw) {
		p.fold(line)
	}
}

// push notes raw as the newest record handed to the projection, numbered as
// session.HistorySeqs numbers a history.
func (p *Projection) push(raw json.RawMessage) {
	if seq := session.NextHistorySeq(p.t.pushed, raw); seq.Valid() {
		p.t.pushed = seq
	}
}

// State is what the records folded so far say. It shares nothing the
// projection goes on changing.
func (p *Projection) State() State {
	return p.settledView().state.clone()
}

// settledView is the projection read as if nothing follows. That is p
// itself unless the history ends on a message whose turn is read off the
// record after it (agent.TurnInference); then it is a copy with the message
// folded in, since something still may follow. Never folded into.
func (p *Projection) settledView() *Projection {
	if p.settled != nil {
		return p.settled
	}
	settled := p.inference.Settle(nil)
	if len(settled) == 0 {
		return p
	}
	c := p.clone()
	for _, line := range settled {
		c.fold(line)
	}
	p.settled = c
	return c
}

func (p *Projection) clone() *Projection {
	c := *p
	c.state = p.state.clone()
	c.questions = make(map[string][]int, len(p.questions))
	for id, idx := range p.questions {
		c.questions[id] = append([]int(nil), idx...)
	}
	c.delivered = make(map[string][]string, len(p.delivered))
	for id, ids := range p.delivered {
		c.delivered[id] = append([]string(nil), ids...)
	}
	c.items = p.items.clone()
	c.settledIn = cloneMap(p.settledIn)
	c.t = p.t.clone()
	c.settled = nil
	return &c
}

func (p *Projection) fold(line agent.InferredLine) {
	p.t.begin(line)
	defer p.t.end()
	defer p.raiseTouched()
	rec, err := agent.DecodeRecord(line.Raw)
	if err != nil {
		// A line that does not parse, or of a type this build does not know,
		// says nothing any reader of this state could use.
		return
	}
	p.foldTurn(rec, line)
	for _, f := range normalize(rec) {
		p.apply(f, line)
	}
	p.transcribe(rec, line)
}

// foldTurn reads the turns off the recorded turn identity: a turn_started
// opens one, and what ends it is a record tagged with it whose signal ends a
// turn, or a process_ended, which belongs to no turn and ends whichever was
// open.
func (p *Projection) foldTurn(rec agent.Record, line agent.InferredLine) {
	if started, ok := rec.(agent.TurnStartedRecord); ok {
		p.state.Turns = append(p.state.Turns, Turn{
			ID:        started.TurnID,
			Origin:    started.Origin,
			MessageID: started.MessageID,
			StartedAt: started.ObservedAt,
			StartSeq:  line.Seq,
		})
		p.openTurn = len(p.state.Turns) - 1
		p.t.markTurn(p.openTurn)
		p.t.turnStarted(p.openTurn, started)
		return
	}
	if p.openTurn < 0 {
		return
	}
	in, ok := agent.TurnInputOf(rec)
	if !ok || !in.Signal.EndsTurn() {
		return
	}
	turn := &p.state.Turns[p.openTurn]
	if in.Signal != session.SignalProcessEnded && line.Turn.ID() != turn.ID {
		return
	}
	turn.Ended = true
	turn.Outcome = in.Signal.Outcome()
	turn.EndedBy = in.Signal
	turn.EndSeq = line.Seq
	turn.EndedAt = endedAt(rec)
	p.t.markTurn(p.openTurn)
	p.openTurn = -1
	// The turn that might still have discarded its answers is over.
	clear(p.delivered)
	if turn.Outcome != session.OutcomeCompleted {
		// Cut short: nothing will report on the calls it left running.
		// Background work outlives a turn that completed, and one that did
		// not.
		p.settleRunning(false)
	}
}

func (p *Projection) apply(f fact, line agent.InferredLine) {
	p.applyItem(f, line)
	turnID := line.Turn.ID()
	switch f := f.(type) {
	case questionAsked:
		if _, dup := p.posted(f.question.RequestID); dup && !f.question.Legacy {
			// A request id names one question; a repeat names it again.
			return
		}
		q := f.question
		q.TurnID, q.Seq, q.Status = turnID, line.Seq, QuestionOpen
		p.questions[q.RequestID] = append(p.questions[q.RequestID], len(p.state.Questions))
		p.state.Questions = append(p.state.Questions, q)
		p.onQuestionAdded(len(p.state.Questions) - 1)
		if !q.Legacy {
			p.state.unanswered = append(p.state.unanswered, q.RequestID)
		}

	case questionAnswered:
		i, ok := p.posted(f.answer.RequestID)
		if !ok {
			return
		}
		q := &p.state.Questions[i]
		answer := f.answer
		q.Status, q.Answer, q.AnsweredIn = QuestionAnswered, &answer, f.messageID
		if answer.Declined {
			q.Status = QuestionDeclined
		}
		q.Reason, q.ResolvedAt = "", nil
		q.DiscardedAnswer, q.DiscardedIn = nil, ""
		if p.dropUnanswered(q.RequestID) && f.messageID != "" {
			p.delivered[f.messageID] = append(p.delivered[f.messageID], q.RequestID)
		}

	case legacyAnswered:
		p.settleLegacy(f)

	case questionWithdrawn:
		for _, i := range p.questions[f.requestID] {
			q := &p.state.Questions[i]
			if q.Legacy && q.Status != QuestionOpen {
				// The CLI's own question was never reopened: what settled it
				// first holds (settleLegacy).
				continue
			}
			q.Status, q.Answer, q.AnsweredIn = QuestionWithdrawn, nil, ""
			q.Reason, q.ResolvedAt = f.reason, f.at
			q.DiscardedAnswer, q.DiscardedIn = nil, ""
		}
		p.dropUnanswered(f.requestID)
		p.dropDelivered(f.requestID)

	case messageSent:
		p.onMessageSent(f.message)

	case messageDiscarded:
		p.onMessageDiscarded(f.messageID)
		p.state.Discarded = append(p.state.Discarded, DiscardedMessage{
			MessageID: f.messageID, Excerpt: f.excerpt, Seq: line.Seq, TurnID: turnID,
		})
		if turn := p.t.turnOf(turnID); turn >= 0 {
			p.t.markTurn(turn)
		}
		if f.messageID == "" {
			return
		}
		for _, requestID := range p.delivered[f.messageID] {
			if i, ok := p.posted(requestID); ok {
				q := &p.state.Questions[i]
				q.DiscardedAnswer, q.DiscardedIn = q.Answer, q.AnsweredIn
				q.Status, q.Answer, q.AnsweredIn = QuestionOpen, nil, ""
				p.state.unanswered = append(p.state.unanswered, requestID)
				p.t.mark(p.t.questionEntry[i])
			}
		}
		delete(p.delivered, f.messageID)

	case messageRead:
		p.state.ReadPoints = append(p.state.ReadPoints, ReadPoint{
			MessageID: f.messageID, ObservedAt: f.at, Seq: line.Seq, TurnID: turnID,
		})

	case planStated:
		if f.plan.ParentToolUseID != "" {
			// A subagent's own checklist, not the session's plan.
			return
		}
		plan := &Plan{Record: f.plan, Seq: line.Seq, TurnID: turnID}
		p.state.Plan = plan
		p.t.markPlan()
		if f.plan.ToolUseID != "" {
			p.state.taskPlan = plan
		}
	}
}

// endedAt is the moment the record that ended a turn carries.
func endedAt(rec agent.Record) *time.Time {
	switch r := rec.(type) {
	case agent.DoneRecord:
		return r.ObservedAt
	case agent.InterruptedRecord:
		return r.ObservedAt
	case agent.ProcessEndedRecord:
		return r.ObservedAt
	case agent.ErrorRecord:
		return r.ObservedAt
	}
	return nil
}

// posted is the question_post question requestID names.
func (p *Projection) posted(requestID string) (int, bool) {
	for _, i := range p.questions[requestID] {
		if !p.state.Questions[i].Legacy {
			return i, true
		}
	}
	return 0, false
}

func (p *Projection) dropUnanswered(requestID string) bool {
	for i, id := range p.state.unanswered {
		if id == requestID {
			p.state.unanswered = append(p.state.unanswered[:i:i], p.state.unanswered[i+1:]...)
			return true
		}
	}
	return false
}

// dropDelivered lets go of an answer the agent may not have read, for a
// question nobody is waiting on any more: a withdrawal means nobody wants its
// answer, read or not (session.SignalQuestionResolved).
func (p *Projection) dropDelivered(requestID string) {
	for messageID, ids := range p.delivered {
		kept := ids[:0:0]
		for _, id := range ids {
			if id != requestID {
				kept = append(kept, id)
			}
		}
		if len(kept) == 0 {
			delete(p.delivered, messageID)
		} else {
			p.delivered[messageID] = kept
		}
	}
}

// settleLegacy settles the CLI's own questions a question_response names. A
// nil map is the CLI having cancelled them.
func (p *Projection) settleLegacy(f legacyAnswered) {
	var targets []int
	for _, i := range p.questions[f.requestID] {
		if q := p.state.Questions[i]; q.Legacy && q.Status == QuestionOpen {
			targets = append(targets, i)
		}
	}
	for _, i := range targets {
		q := &p.state.Questions[i]
		if f.answers == nil {
			q.Status = QuestionWithdrawn
			continue
		}
		flat, _ := lookupLegacyAnswer(*q, f.answers, len(targets))
		labels, text := parseLegacyAnswer(flat, q.Options)
		q.Status = QuestionAnswered
		q.Answer = &agent.QuestionAnswer{
			RequestID: f.requestID,
			Header:    q.Header,
			Question:  q.Question,
			Answers:   labels,
			Text:      text,
		}
	}
}
