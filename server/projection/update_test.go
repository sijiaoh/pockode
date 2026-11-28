package projection

import (
	"reflect"
	"testing"

	"github.com/pockode/server/session"
)

// clientCopy is what a client keeps of a transcript: each item by id, apart
// from the items nested in it, with where it sits; and each turn its items
// name. Order is not kept: an item's id is its place.
type clientCopy struct {
	items map[int]placedItem
	turns map[string]TurnUpdate
}

type placedItem struct {
	item   PageItem
	parent int
	turnID string
}

func newClientCopy(t *testing.T, page Page) clientCopy {
	t.Helper()
	c := clientCopy{items: map[int]placedItem{}, turns: map[string]TurnUpdate{}}
	var place func(item PageItem, parent int, turnID string)
	place = func(item PageItem, parent int, turnID string) {
		var children []PageItem
		if item.Tool != nil {
			tool := *item.Tool
			children, tool.Children = tool.Children, nil
			item.Tool = &tool
		}
		c.items[item.ID] = placedItem{item: item, parent: parent, turnID: turnID}
		for _, child := range children {
			place(child, item.ID, "")
		}
	}
	for _, stretch := range page.Turns {
		turnID := ""
		if stretch.Turn != nil {
			turnID = stretch.Turn.ID
			c.turns[turnID] = TurnUpdate{Turn: *stretch.Turn, Discarded: stretch.Discarded}
		}
		for _, item := range stretch.Items {
			place(item, 0, turnID)
		}
	}
	return c
}

func (c clientCopy) apply(t *testing.T, u Update) {
	t.Helper()
	for _, turn := range u.Turns {
		c.turns[turn.Turn.ID] = turn
	}
	for _, it := range u.Items {
		if it.Item.Tool != nil && it.Item.Tool.Children != nil {
			t.Errorf("item %d came with its children", it.Item.ID)
		}
		if it.Parent != 0 {
			if _, ok := c.items[it.Parent]; !ok {
				t.Errorf("item %d names parent %d, which the client does not have", it.Item.ID, it.Parent)
			}
		}
		c.items[it.Item.ID] = placedItem{item: it.Item, parent: it.Parent, turnID: it.TurnID}
	}
}

// named is the copy's turns its items name: a turn with no items is not drawn,
// and one a page settled ahead of the record after it (Projection.Page) can
// lose its items to the turn that record says they are in.
func (c clientCopy) named() map[string]TurnUpdate {
	out := map[string]TurnUpdate{}
	for _, it := range c.items {
		if turn, ok := c.turns[it.turnID]; ok {
			out[it.turnID] = turn
		}
	}
	return out
}

// TestUpdate_KeepsAPageCurrent is the contract a subscription rests on: a
// client holding the page cut after any prefix, applying the update taken
// after each record written since, holds what a page cut at the end says —
// every item as it stands, where it stands, and the turns they are in.
func TestUpdate_KeepsAPageCurrent(t *testing.T) {
	for _, agentType := range []session.AgentType{session.AgentTypeClaude, session.AgentTypeCodex} {
		for cut := 0; cut <= len(mixedHistory); cut++ {
			p := Fold(mixedHistory[:cut], agentType)
			p.TrackChanges()
			client := newClientCopy(t, newestPage(t, p))
			for _, raw := range mixedHistory[cut:] {
				p.AppendWritten(raw)
				assertSubtreeLast(t, p)
				client.apply(t, p.TakeUpdate())
			}
			want := newClientCopy(t, newestPage(t, p))
			if !reflect.DeepEqual(client.items, want.items) {
				for id, it := range want.items {
					if got := client.items[id]; !reflect.DeepEqual(got, it) {
						t.Errorf("%s, cut at %d: item %d is\n  %+v\nwant\n  %+v", agentType, cut, id, got, it)
					}
				}
				for id := range client.items {
					if _, ok := want.items[id]; !ok {
						t.Errorf("%s, cut at %d: the client has item %d, which the page does not", agentType, cut, id)
					}
				}
			}
			if got, want := client.named(), want.named(); !reflect.DeepEqual(got, want) {
				t.Errorf("%s, cut at %d: turns\n  %+v\nwant\n  %+v", agentType, cut, got, want)
			}
		}
	}
}

// assertSubtreeLast holds the subtreeLast the fold keeps to the walk over
// the subtree it saves.
func assertSubtreeLast(t *testing.T, p *Projection) {
	t.Helper()
	var walk func(i int) session.HistorySeq
	walk = func(i int) session.HistorySeq {
		last := p.t.entries[i].last
		for _, c := range p.childrenOf(i) {
			last = max(last, walk(c))
		}
		return last
	}
	for i := range p.t.entries {
		if got, want := p.subtreeLast(i), walk(i); got != want {
			t.Fatalf("entry %d (%s): subtreeLast %d, the walk over its subtree %d", i, p.t.entries[i].kind, got, want)
		}
	}
}

// An update says only what changed: a record that names one item sends that
// item, and the runs it is nested in for their last_seq — not the rest of the
// transcript.
func TestUpdate_SendsOnlyWhatChanged(t *testing.T) {
	p := Fold(history(prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"task","tool_name":"Task"}`,
		`T1|{"type":"tool_call","tool_use_id":"a","tool_name":"Read","parent_tool_use_id":"task"}`,
		`T1|{"type":"tool_call","tool_use_id":"b","tool_name":"Read","parent_tool_use_id":"task"}`,
	), session.AgentTypeClaude)
	p.TrackChanges()
	p.AppendWritten(history(`T1|{"type":"tool_result","tool_use_id":"b","tool_result":"ok"}`)[0])
	u := p.TakeUpdate()
	if len(u.Turns) != 0 || u.Plan != nil {
		t.Errorf("turns %+v, plan %+v: nothing about them changed", u.Turns, u.Plan)
	}
	var got []string
	for _, it := range u.Items {
		got = append(got, it.Item.Tool.ToolUseID+":"+string(it.Item.Tool.Status))
	}
	assertStrings(t, "items", got, []string{"task:running", "b:succeeded"})
	if u.Items[0].Item.LastSeq != u.ThroughSeq {
		t.Errorf("the parent's last_seq is %d, want the result's, %d", u.Items[0].Item.LastSeq, u.ThroughSeq)
	}
	if again := p.TakeUpdate(); !again.Empty() {
		t.Errorf("a second update with nothing written = %+v", again)
	}
}

// The id of the item a record started is what a sender left out of its
// update learns it by; a record that only changed items started none.
func TestItemAt(t *testing.T) {
	p := Fold(history(prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"c","tool_name":"Read"}`,
		`T1|{"type":"tool_result","tool_use_id":"c","tool_result":"ok"}`,
	), session.AgentTypeClaude)
	page := newestPage(t, p)
	items := page.Turns[0].Items
	if got := p.ItemAt(items[0].Seq); got != items[0].ID {
		t.Errorf("ItemAt(message) = %d, want %d", got, items[0].ID)
	}
	if got := p.ItemAt(items[1].LastSeq); got != 0 {
		t.Errorf("ItemAt(result) = %d, want 0: the result started no item", got)
	}
}

// A message a file ends on is read as the fold will read it once the record
// after it arrives, so its id is the one later updates use.
func TestItemAt_AMessageTheFileEndsOn(t *testing.T) {
	records := history(prompt1, started1, `T1|{"type":"done"}`, prompt2)
	held := Fold(records, session.AgentTypeClaude)
	seq := session.HistorySeq(len(records))
	id := held.ItemAt(seq)
	if id == 0 {
		t.Fatal("ItemAt = 0 for the message the file ends on")
	}
	held.Append(history(`T2|{"type":"turn_started","turn_id":"T2","origin":"prompt"}`)...)
	if got := held.ItemAt(seq); got != id {
		t.Errorf("once the record after it arrived, ItemAt = %d, want %d", got, id)
	}
}

// A run's last_seq counts what is nested in it however that came about: a
// child's record, or children adopted when a parent arrives after them — a
// chain of three arriving from the bottom up, and text naming a call before
// it.
func TestUpdate_RunLastSeqCountsAdoptedWork(t *testing.T) {
	lines := history(prompt1, started1,
		`T1|{"type":"text","content":"early","parent_tool_use_id":"top"}`,
		`T1|{"type":"tool_call","tool_use_id":"leaf","tool_name":"Read","parent_tool_use_id":"mid"}`,
		`T1|{"type":"tool_result","tool_use_id":"leaf","tool_result":"ok","parent_tool_use_id":"mid"}`,
		`T1|{"type":"tool_call","tool_use_id":"mid","tool_name":"Task","parent_tool_use_id":"top"}`,
		`T1|{"type":"tool_call","tool_use_id":"top","tool_name":"Task"}`,
		`T1|{"type":"text","content":"later","parent_tool_use_id":"mid"}`,
		`T1|{"type":"tool_result","tool_use_id":"top","tool_result":"done"}`,
	)
	p := Fold(lines[:2], session.AgentTypeClaude)
	p.TrackChanges()
	client := newClientCopy(t, newestPage(t, p))
	for _, raw := range lines[2:] {
		p.AppendWritten(raw)
		assertSubtreeLast(t, p)
		client.apply(t, p.TakeUpdate())
	}
	top := p.t.itemEntry[p.items.byToolUse["top"]]
	if got, want := p.subtreeLast(top), p.t.lastSeq; got != want {
		t.Errorf("top's subtree ends at %d, want the last record, %d", got, want)
	}
	// Words that named a call before it arrived move under it in an update
	// too, not only in a page.
	if want := newClientCopy(t, newestPage(t, p)); !reflect.DeepEqual(client.items, want.items) {
		t.Errorf("updates left the client with\n  %+v\nthe page says\n  %+v", client.items, want.items)
	}
}
