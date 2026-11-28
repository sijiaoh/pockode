package projection

import (
	"slices"
	"sort"

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
	u := Update{ThroughSeq: p.t.lastSeq}

	turns := make([]int, 0, len(c.turns))
	for i := range c.turns {
		turns = append(turns, i)
	}
	slices.Sort(turns)
	for _, i := range turns {
		stretch := p.pageTurn(i, false)
		u.Turns = append(u.Turns, TurnUpdate{Turn: *stretch.Turn, Discarded: stretch.Discarded})
	}

	// A changed item changes the last_seq of every run it is nested in, so
	// those are sent too; and a parent goes before its children.
	entries := make([]int, 0, len(c.entries))
	for i := range c.entries {
		entries = append(entries, i)
	}
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

	if c.plan {
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

// ItemAt is the id of the item seq's record started (PageItem.ID), 0 when it
// started none: a record that only changed items already there. It is how
// the sender of a message, which is left out of the update that carries it,
// learns what later updates call it.
func (p *Projection) ItemAt(seq session.HistorySeq) int {
	if !seq.Valid() {
		return 0
	}
	// A message read off a file waits on the record after it, and is read
	// as if nothing follows, as Page is. The entry it gets is the one the fold
	// gives it once that record arrives.
	return p.settledView().itemAt(seq)
}

func (p *Projection) itemAt(seq session.HistorySeq) int {
	entries := p.t.entries
	i := sort.Search(len(entries), func(i int) bool { return entries[i].pos >= seq })
	for ; i < len(entries) && entries[i].pos == seq; i++ {
		if entries[i].numbered {
			return i + 1
		}
	}
	return 0
}
