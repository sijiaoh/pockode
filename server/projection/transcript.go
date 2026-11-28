package projection

import (
	"slices"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// ItemKind is what a transcript item is. Each kind's payload is the field of
// PageItem named after it.
type ItemKind string

const (
	// KindMessage is a message sent to the agent.
	KindMessage ItemKind = "message"
	KindText    ItemKind = "text"
	// KindThinking is one finished stretch of thinking; a run of them is one
	// row only on the screen.
	KindThinking ItemKind = "thinking"
	// KindTool is one tool run (Item), its nested work inside it.
	KindTool ItemKind = "tool"
	// KindQuestion is one question and what became of it, posted or the
	// CLI's own (Question.Legacy).
	KindQuestion ItemKind = "question"
	// KindPlan is a plan record filed on no call in the history: a Codex
	// plan, which belongs to no run, or one whose call a fork cut dropped.
	KindPlan ItemKind = "plan"
	// KindRead is a read point: the agent picked up a message sent while its
	// turn ran (agent.MessageIngestedRecord).
	KindRead          ItemKind = "read"
	KindSystem        ItemKind = "system"
	KindWarning       ItemKind = "warning"
	KindError         ItemKind = "error"
	KindRaw           ItemKind = "raw"
	KindCommandOutput ItemKind = "command_output"
)

// entry is one transcript item as the fold keeps it: where it sits, which
// records went into it, and what it is. A tool run's or a question's state is
// the projection's own (State.Items, State.Questions); every other kind is the
// one record it was made from, which nothing changes after.
type entry struct {
	kind ItemKind
	// pos is the seq of the item's first record, or for a record in no file
	// the seq of the numbered record before it: what orders items and what a
	// page cursor names.
	pos      session.HistorySeq
	numbered bool
	// last is the seq of the newest numbered record that named the item.
	last session.HistorySeq
	// subtreeLast is the newest last of the item and everything nested in
	// it (Projection.raise), kept as it changes so that an update re-sending
	// a run for its last_seq costs the run, not its whole subtree.
	subtreeLast session.HistorySeq
	// records counts the records that named it, which is what a page's budget
	// is spent in.
	records int
	// turn is the item's turn, an index in State.Turns; -1 for none.
	turn int
	// parent is the subagent call a text, thinking or plan record names.
	// A tool run's is its Item's.
	parent string
	// ref is the item's index in State.Items or State.Questions.
	ref    int
	record agent.Record
	// discarded is a message's: a Stop threw it away unread.
	discarded bool
	// changed is the record whose fold last changed the item (transcript.pushed
	// as it was marked): what Projection.Since reads.
	changed session.HistorySeq
}

// transcript is the fold's ordered account of everything a chat draws.
type transcript struct {
	entries []entry
	// children are, by the tool use id a record names as its parent, the
	// entries naming it, in the order they were filed.
	children map[string][]int
	// itemEntry and questionEntry are the entries of State.Items and
	// State.Questions, by index.
	itemEntry     []int
	questionEntry []int
	// messages are the message entries by message id.
	messages map[string]int
	// turns indexes State.Turns by turn id.
	turns map[string]int
	// unopened is the newest message no turn has taken yet, -1 for none: the
	// one a turn_started after it may name as its opener.
	unopened int
	// lastSeq is the seq of the newest numbered record folded.
	lastSeq session.HistorySeq
	// pushed is the seq of the newest numbered record handed to the
	// projection, folded or not: what a change is stamped with (mark). Not
	// lastSeq, because a message read off a file is folded only with the
	// record after it, and what that changes is that record's doing.
	pushed session.HistorySeq
	// unnumbered is whether an entry came from a line in no file — the
	// warning the store reads in for records it skipped. The store adds it
	// at the end of whatever it read, so a fold from the file again files
	// it, and every entry after where it stood, under other item ids.
	unnumbered bool
	// turnChanged and planChanged are entry.changed for each turn, by its
	// index in State.Turns, and for the session's plan.
	turnChanged []session.HistorySeq
	planChanged session.HistorySeq

	// line is the line being folded, and touched the entries it has named so
	// far.
	line    agent.InferredLine
	touched []int

	// changed is what has changed since it was last taken (TakeUpdate); nil
	// while nobody is taking it (TrackChanges).
	changed *changes
}

// changes are the entries, turns and plan the records folded since the last
// update changed: an entry a record named, or one moved without being named —
// settled when its turn was cut short, expired with its process, adopted by a
// parent that arrived after it, taken into the turn its message opened.
type changes struct {
	entries map[int]struct{}
	turns   map[int]struct{}
	plan    bool
}

func newChanges() *changes {
	return &changes{entries: map[int]struct{}{}, turns: map[int]struct{}{}}
}

// mark, markTurn and markPlan are the one place a change is recorded, for
// both readers of it: the next update (changes), and Projection.Since (the
// stamps). Since is right for exactly the reason an update is — it reads
// what was marked.
func (t *transcript) mark(i int) {
	t.entries[i].changed = t.pushed
	if t.changed != nil {
		t.changed.entries[i] = struct{}{}
	}
}

func (t *transcript) markTurn(i int) {
	for len(t.turnChanged) <= i {
		t.turnChanged = append(t.turnChanged, session.NoHistorySeq)
	}
	t.turnChanged[i] = t.pushed
	if t.changed != nil {
		t.changed.turns[i] = struct{}{}
	}
}

func (t *transcript) markPlan() {
	t.planChanged = t.pushed
	if t.changed != nil {
		t.changed.plan = true
	}
}

func newTranscript() transcript {
	return transcript{
		children: map[string][]int{},
		messages: map[string]int{},
		turns:    map[string]int{},
		unopened: -1,
	}
}

func (t transcript) clone() transcript {
	c := t
	c.entries = slices.Clone(t.entries)
	c.children = make(map[string][]int, len(t.children))
	for id, children := range t.children {
		c.children[id] = slices.Clone(children)
	}
	c.itemEntry = slices.Clone(t.itemEntry)
	c.questionEntry = slices.Clone(t.questionEntry)
	c.messages = cloneMap(t.messages)
	c.turns = cloneMap(t.turns)
	c.turnChanged = slices.Clone(t.turnChanged)
	c.touched = nil
	// A copy is read, never taken updates from.
	c.changed = nil
	return c
}

// begin readies the transcript for line, before anything of it is folded.
func (t *transcript) begin(line agent.InferredLine) {
	t.line, t.touched = line, t.touched[:0]
}

// end closes the line begin opened.
func (t *transcript) end() {
	if t.line.Seq.Valid() {
		t.lastSeq = t.line.Seq
	}
}

// add files a new entry for the line being folded; the line counts toward
// it once it is touched.
func (t *transcript) add(e entry) int {
	e.pos, e.numbered = t.line.Seq, t.line.Seq.Valid()
	if !e.numbered {
		e.pos = t.lastSeq
		t.unnumbered = true
	}
	i := len(t.entries)
	t.entries = append(t.entries, e)
	t.touch(i)
	if e.parent != "" {
		t.children[e.parent] = append(t.children[e.parent], i)
	}
	return i
}

// touch counts the line being folded toward entry i, once.
func (t *transcript) touch(i int) {
	if slices.Contains(t.touched, i) {
		return
	}
	t.touched = append(t.touched, i)
	t.mark(i)
	e := &t.entries[i]
	e.records++
	if t.line.Seq.Valid() {
		e.last = t.line.Seq
	}
}

func (t *transcript) turnOf(turnID string) int {
	if turnID == "" {
		return -1
	}
	if i, ok := t.turns[turnID]; ok {
		return i
	}
	return -1
}

// turnStarted records turn i, and takes the message that opened it into it.
func (t *transcript) turnStarted(i int, started agent.TurnStartedRecord) {
	t.turns[started.TurnID] = i
	opener := t.unopened
	if started.MessageID != "" {
		var ok bool
		if opener, ok = t.messages[started.MessageID]; !ok {
			opener = -1
		}
	}
	if started.Origin == agent.TurnOriginPrompt && opener >= 0 && t.entries[opener].turn < 0 {
		t.entries[opener].turn = i
		t.mark(opener)
	}
	t.unopened = -1
}

// onItemAdded files the entry of the tool run just added at index i.
func (p *Projection) onItemAdded(i int) {
	item := p.state.Items[i]
	e := p.t.add(entry{kind: KindTool, turn: p.t.turnOf(item.TurnID), ref: i})
	p.t.itemEntry = append(p.t.itemEntry, e)
	if item.ToolUseID != "" {
		p.onAdopted(e)
	}
}

// onNested files a tool run under the call it names as its parent, once it
// names one.
func (p *Projection) onNested(item *Item) {
	i, ok := p.items.byToolUse[item.ToolUseID]
	if !ok {
		return
	}
	child := p.t.itemEntry[i]
	p.t.children[item.ParentToolUseID] = append(p.t.children[item.ParentToolUseID], child)
	if parent, ok := p.nestedIn(child); ok {
		p.raise(parent, p.t.entries[child].subtreeLast)
	}
}

// onAdopted takes in the entries that named tool run entry i, just added, as
// their parent before it arrived and are nested in it now — calls, words and
// thinking alike: each moves under it, which no record of its own says, and
// raises its subtreeLast.
func (p *Projection) onAdopted(i int) {
	for _, c := range p.childrenOf(i) {
		p.t.mark(c)
		p.raise(i, p.t.entries[c].subtreeLast)
	}
}

// raiseTouched carries the line just folded into the subtreeLast of every
// entry it named and of the runs they are nested in.
func (p *Projection) raiseTouched() {
	for _, i := range p.t.touched {
		p.raise(i, p.t.entries[i].last)
	}
}

// raise makes seq the subtreeLast of entry i and of every run it is nested
// in, as far up as one is older. A run's subtreeLast is never older than a
// child's, so the first that is not older ends the walk; and nesting has no
// cycles (nest), so the walk ends at a root.
func (p *Projection) raise(i int, seq session.HistorySeq) {
	for {
		e := &p.t.entries[i]
		if e.subtreeLast >= seq {
			return
		}
		e.subtreeLast = seq
		parent, ok := p.nestedIn(i)
		if !ok {
			return
		}
		i = parent
	}
}

func (p *Projection) onQuestionAdded(i int) {
	q := p.state.Questions[i]
	p.t.questionEntry = append(p.t.questionEntry, p.t.add(entry{kind: KindQuestion, turn: p.t.turnOf(q.TurnID), ref: i}))
}

func (p *Projection) onMessageSent(msg agent.MessageRecord) {
	turn := p.openTurn
	i := p.t.add(entry{kind: KindMessage, turn: turn, record: msg})
	if msg.MessageID != "" {
		p.t.messages[msg.MessageID] = i
	}
	if turn < 0 {
		p.t.unopened = i
	}
}

func (p *Projection) onMessageDiscarded(messageID string) {
	if i, ok := p.t.messages[messageID]; ok && messageID != "" {
		p.t.entries[i].discarded = true
		p.t.mark(i)
	}
}

// transcribe files what rec adds to the transcript that the state's own fold
// did not: the records that are items of their own, and every record naming
// an item, which counts toward it.
func (p *Projection) transcribe(rec agent.Record, line agent.InferredLine) {
	turn := p.t.turnOf(line.Turn.ID())
	switch r := rec.(type) {
	case agent.TextRecord:
		p.t.add(entry{kind: KindText, turn: turn, parent: r.ParentToolUseID, record: r})
	case agent.ThinkingRecord:
		p.t.add(entry{kind: KindThinking, turn: turn, parent: r.ParentToolUseID, record: r})
	case agent.SystemRecord:
		p.t.add(entry{kind: KindSystem, turn: turn, record: r})
	case agent.WarningRecord:
		p.t.add(entry{kind: KindWarning, turn: turn, record: r})
	case agent.ErrorRecord:
		p.t.add(entry{kind: KindError, turn: turn, record: r})
	case agent.RawRecord:
		p.t.add(entry{kind: KindRaw, turn: turn, record: r})
	case agent.CommandOutputRecord:
		p.t.add(entry{kind: KindCommandOutput, turn: turn, record: r})
	case agent.MessageIngestedRecord:
		p.t.add(entry{kind: KindRead, turn: turn, record: r})
	case agent.PlanRecord:
		if !p.touchItem(r.ToolUseID) {
			p.t.add(entry{kind: KindPlan, turn: turn, parent: r.ParentToolUseID, record: r})
		}

	case agent.ToolCallRecord:
		p.touchItem(r.ToolUseID)
	case agent.ToolResultRecord:
		p.touchItem(r.ToolUseID)
	case agent.PermissionRequestRecord:
		p.touchRequest(r.RequestID)
	case agent.PermissionResponseRecord:
		p.touchRequest(r.RequestID)
	case agent.RequestCancelledRecord:
		p.touchRequest(r.RequestID)
		p.touchQuestions(r.RequestID)
	case agent.QuestionPostedRecord:
		p.touchQuestions(r.RequestID)
	case agent.AskUserQuestionRecord:
		p.touchQuestions(r.RequestID)
	case agent.QuestionResponseRecord:
		p.touchQuestions(r.RequestID)
	case agent.MessageRecord:
		for _, a := range r.Answering {
			p.touchQuestions(a.RequestID)
		}
	}
}

func (p *Projection) touchItem(toolUseID string) bool {
	if toolUseID == "" {
		return false
	}
	i, ok := p.items.byToolUse[toolUseID]
	if ok {
		p.t.touch(p.t.itemEntry[i])
	}
	return ok
}

func (p *Projection) touchRequest(requestID string) {
	if i, ok := p.items.byRequest[requestID]; ok && requestID != "" {
		p.t.touch(p.t.itemEntry[i])
	}
}

func (p *Projection) touchQuestions(requestID string) {
	if requestID == "" {
		return
	}
	for _, i := range p.questions[requestID] {
		p.t.touch(p.t.questionEntry[i])
	}
}
