package projection

import (
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// Update is what the records folded since the last update changed in the
// transcript, each thing as it stands now: the turns that started or ended or
// had a message discarded, the items that changed, and the session's plan if
// it did. It is how a client holding a page is kept current without being
// sent the page again (docs/agent-chat.md#live-updates).
//
// Every item is upserted on its own, nested ones included, so a long
// subagent run costs each update the items it changed rather than the whole
// run: a tool run comes without its children, which are items of their own.
// Everything else about an item is complete, and replaces the client's copy.
type Update struct {
	// ThroughSeq is the newest record folded into the update — the same as
	// Page.ThroughSeq of a page cut at the same moment.
	ThroughSeq session.HistorySeq `json:"through_seq,omitempty"`
	// Turns come before Items, so an item names a turn the client has.
	Turns []TurnUpdate `json:"turns,omitempty"`
	// Items are in an order a client can apply them one by one: a tool run
	// before what is nested in it, and otherwise oldest first. A new item is
	// newer than every item the client has at its level, so it goes at the
	// end of its turn or of its parent's children; an item the client has is
	// replaced where it is, unless its Parent says it has moved.
	Items []ItemUpdate `json:"items,omitempty"`
	// Plan is the session's current plan, when it changed (Page.Plan).
	Plan *PageItem `json:"plan,omitempty"`
}

// Empty says the update changes nothing.
func (u Update) Empty() bool {
	return len(u.Turns) == 0 && len(u.Items) == 0 && u.Plan == nil
}

// TurnUpdate is a turn as it stands now, with the messages the Stop that
// ended it threw away (PageTurn.Discarded).
type TurnUpdate struct {
	Turn      Turn               `json:"turn"`
	Discarded []DiscardedMessage `json:"discarded,omitempty"`
}

// ItemUpdate is one item and where it sits.
type ItemUpdate struct {
	// TurnID is the turn a top-level item belongs to, "" for none. A message
	// whose turn started after it moves into that turn with an update saying
	// so. Not set on a nested item, which goes with its parent.
	TurnID string `json:"turn_id,omitempty"`
	// Parent is the id of the tool run the item is nested in, 0 for a
	// top-level item. A call recorded before the subagent call it ran inside
	// moves from the top level into it once that call arrives.
	Parent int      `json:"parent,omitempty"`
	Item   PageItem `json:"item"`
}

// TrackChanges starts keeping what each record folded from now on changes,
// for TakeUpdate. Until it is called nothing is kept: a fold read once and
// dropped has nobody to tell.
func (p *Projection) TrackChanges() {
	if p.t.changed == nil {
		p.t.changed = newChanges()
	}
}

// TakeUpdate is what changed since the last call (or since TrackChanges),
// and starts over.
func (p *Projection) TakeUpdate() Update {
	c := p.t.changed
	if c == nil {
		return Update{}
	}
	p.t.changed = newChanges()
	return p.update(slices.Collect(maps.Keys(c.turns)), slices.Collect(maps.Keys(c.entries)), c.plan)
}

// MaxResumeGap is the most records Since will answer for. Past it the
// update would carry what a page's budget never lets a reply carry
// (MaxPageSize), and a client is better served by a fresh page.
const MaxResumeGap = MaxPageSize

// ErrResumeUnavailable reports a Since that cannot be answered: the seq is
// past the newest record — the history is not the one the seq was read from
// — or further behind it than MaxResumeGap, or the history holds a line in
// no file, whose item ids a copy cannot be trusted to share (unnumbered).
// The caller sends a page instead.
var ErrResumeUnavailable = errors.New("cannot resume from this seq")

// Since is everything the records after seq changed, as one Update: every
// turn and item they changed, as each stands now, and the plan if they
// changed it. Applied to a copy that was current through seq — a page or an
// update whose through_seq is seq, and everything before it — it makes the
// copy what a page cut now would say about each item it holds, which is how
// a client that lost its connection is brought up to date without being
// sent again what it already has.
//
// It reads the same marks an update is made from (transcript.mark), stamped
// with the record whose fold made them, so it is TakeUpdate taken over every
// record after seq at once. Read as Page is, as if nothing follows.
func (p *Projection) Since(seq session.HistorySeq) (Update, error) {
	return p.settledView().since(seq)
}

func (p *Projection) since(seq session.HistorySeq) (Update, error) {
	if !seq.Valid() || seq > p.t.lastSeq {
		return Update{}, fmt.Errorf("%w: seq %d, newest record %d", ErrResumeUnavailable, seq, p.t.lastSeq)
	}
	if p.t.lastSeq-seq > MaxResumeGap {
		return Update{}, fmt.Errorf("%w: %d records since seq %d, more than %d",
			ErrResumeUnavailable, p.t.lastSeq-seq, seq, MaxResumeGap)
	}
	if p.t.unnumbered {
		return Update{}, fmt.Errorf("%w: the history holds a line in no file", ErrResumeUnavailable)
	}
	var turns, entries []int
	for i, changed := range p.t.turnChanged {
		if changed > seq {
			turns = append(turns, i)
		}
	}
	for i := range p.t.entries {
		if p.t.entries[i].changed > seq {
			entries = append(entries, i)
		}
	}
	return p.update(turns, entries, p.t.planChanged > seq), nil
}

// update is the Update for the turns and entries named, by index, and the
// plan when plan is set.
func (p *Projection) update(turns, entries []int, plan bool) Update {
	u := Update{ThroughSeq: p.t.lastSeq}

	slices.Sort(turns)
	for _, i := range turns {
		stretch := p.pageTurn(i, false)
		u.Turns = append(u.Turns, TurnUpdate{Turn: *stretch.Turn, Discarded: stretch.Discarded})
	}

	// A changed item changes the last_seq of every run it is nested in, so
	// those are sent too; and a parent goes before its children.
	slices.Sort(entries)
	sent := make(map[int]bool, len(entries))
	var emit func(i int)
	emit = func(i int) {
		if sent[i] {
			return
		}
		sent[i] = true
		up := ItemUpdate{Item: p.entryItem(i, false)}
		if parent, ok := p.nestedIn(i); ok {
			emit(parent)
			up.Parent = parent + 1
		} else if turn := p.t.entries[i].turn; turn >= 0 {
			up.TurnID = p.state.Turns[turn].ID
		}
		u.Items = append(u.Items, up)
	}
	for _, i := range entries {
		emit(i)
	}

	if plan {
		u.Plan = p.currentPlan()
	}
	return u
}

// nestedIn is the entry of the tool run entry i is nested in.
func (p *Projection) nestedIn(i int) (int, bool) {
	parent := p.parentOf(i)
	if parent == "" {
		return 0, false
	}
	item, ok := p.items.byToolUse[parent]
	if !ok {
		return 0, false
	}
	return p.t.itemEntry[item], true
}

// RecordedMessage is a message record as history holds it, and where.
type RecordedMessage struct {
	Seq    session.HistorySeq
	Record agent.MessageRecord
}

// Message is the record carrying messageID (agent.MessageRecord.MessageID),
// if history has one. It is how a send retried under the id its sender minted
// finds that the first attempt already wrote it.
func (p *Projection) Message(messageID string) (RecordedMessage, bool) {
	if messageID == "" {
		return RecordedMessage{}, false
	}
	// A message read off a file waits on the record after it; it is in
	// history all the same.
	v := p.settledView()
	i, ok := v.t.messages[messageID]
	if !ok {
		return RecordedMessage{}, false
	}
	rec, ok := v.t.entries[i].record.(agent.MessageRecord)
	return RecordedMessage{Seq: v.t.entries[i].pos, Record: rec}, ok
}
