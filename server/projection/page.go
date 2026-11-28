package projection

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/htmlpage"
	"github.com/pockode/server/session"
)

// DefaultPageSize is the budget, in records, a client gets when it does not
// ask for one. A long session's history is mostly tool calls and their
// results; sending all of it costs transport, parsing and memory on a client
// that will only ever render the tail of it.
const DefaultPageSize = 50

// MaxPageSize caps the budget one request can ask for. A larger limit is
// clamped rather than refused: the page a client gets is still correct, and
// the cursor tells it there is more.
const MaxPageSize = 500

// ErrInvalidCursor reports a BeforeSeq that names no place in the history.
// Wrapped in a message that says what was asked for.
var ErrInvalidCursor = errors.New("invalid history cursor")

// ErrInvalidLimit reports a page budget that cannot be honoured. Only a
// negative one: zero and oversized limits have a defined meaning.
var ErrInvalidLimit = errors.New("invalid history page size")

// Page is one window onto a session's transcript: its items, oldest first,
// grouped by the turn each belongs to.
//
// Every item is complete as it stands now — a tool run carries its status,
// its permission request and answer, its result and the work nested inside
// it — so a page can be read without any other: what an older page holds is
// earlier items, never a missing piece of one on this page.
type Page struct {
	Turns []PageTurn `json:"turns"`
	// HasMore says items older than this page's first exist.
	HasMore bool `json:"has_more"`
	// NextBeforeSeq is the cursor for the page before this one: pass it back
	// as beforeSeq to get the items immediately older than this page's first.
	// NoHistorySeq when HasMore is false.
	NextBeforeSeq session.HistorySeq `json:"next_before_seq,omitempty"`
	// ThroughSeq is the newest record the transcript had folded when the page
	// was cut: a record at or before it is in what the page says, whichever
	// item it went into.
	ThroughSeq session.HistorySeq `json:"through_seq,omitempty"`
	// Plan is the session's current plan as of ThroughSeq (State.Plan), as an
	// item; absent for a session that never stated one. It is state, not an
	// item of this page: the newest plan can be on any page, or on none.
	Plan *PageItem `json:"plan,omitempty"`
}

// PageTurn is a stretch of a page's items that belong to one turn — or to
// none, outside every turn (Turn nil): a message whose turn never started, a
// warning written between turns.
//
// A turn is usually one stretch. A page boundary can cut it in two, and
// output tagged with a turn after the next one has started (a Codex
// straggler) is a stretch of its own after that turn's; each stretch names the
// whole turn, so it reads on its own either way.
type PageTurn struct {
	Turn *Turn `json:"turn,omitempty"`
	// Continued says the item before this stretch's first, on the older page,
	// belongs to the same turn: the page boundary cut the turn here.
	Continued bool       `json:"continued,omitempty"`
	Items     []PageItem `json:"items"`
	// Discarded are the messages the Stop that ended Turn threw away unread.
	Discarded []DiscardedMessage `json:"discarded,omitempty"`

	// index is Turn's index in State.Turns, -1 for none.
	index int
}

// PageItem is one transcript item. Kind says which payload field is set: the
// one named after it.
type PageItem struct {
	// ID names the item for as long as the session's history is the one it
	// was read from: the same item has the same id on every page and in every
	// update (Update), and no other item has it. It is the item's place among
	// all the transcript's items, nested ones included, counted from one; a
	// client keys its copy by it and derives nothing from it.
	ID   int      `json:"id,omitempty"`
	Kind ItemKind `json:"kind"`
	// Seq is the seq of the item's first record, absent for one in no file.
	Seq session.HistorySeq `json:"seq,omitempty"`
	// LastSeq is the seq of the newest record that went into the item — for
	// a tool run, the newest of its nested items' too. What a fork anchored on
	// the item cuts through.
	LastSeq session.HistorySeq `json:"last_seq,omitempty"`

	Message       *MessageItem  `json:"message,omitempty"`
	Text          *TextItem     `json:"text,omitempty"`
	Thinking      *ThinkingItem `json:"thinking,omitempty"`
	Tool          *ToolItem     `json:"tool,omitempty"`
	Question      *Question     `json:"question,omitempty"`
	Plan          *PlanItem     `json:"plan,omitempty"`
	Read          *ReadItem     `json:"read,omitempty"`
	System        *NoteItem     `json:"system,omitempty"`
	Warning       *WarningItem  `json:"warning,omitempty"`
	Error         *ErrorItem    `json:"error,omitempty"`
	Raw           *NoteItem     `json:"raw,omitempty"`
	CommandOutput *NoteItem     `json:"command_output,omitempty"`
}

// MessageItem is a message sent to the agent (agent.MessageRecord), its
// origin in today's terms.
type MessageItem struct {
	MessageID   string                   `json:"message_id,omitempty"`
	Content     string                   `json:"content,omitempty"`
	ObservedAt  *time.Time               `json:"observed_at,omitempty"`
	Origin      agent.MessageOrigin      `json:"origin,omitempty"`
	Subtype     agent.MessageSubtype     `json:"subtype,omitempty"`
	Meta        *agent.MessageMeta       `json:"meta,omitempty"`
	Answering   []agent.QuestionAnswer   `json:"answering,omitempty"`
	Command     *agent.CommandInvocation `json:"command,omitempty"`
	HTMLAction  *htmlpage.Action         `json:"html_action,omitempty"`
	Attachments []agent.FileBlock        `json:"attachments,omitempty"`
	// Discarded says a Stop threw the message away before the agent read it.
	Discarded bool `json:"discarded,omitempty"`
}

// TextItem is what the agent wrote. ParentToolUseID is set on a subagent's
// words wherever they sit: nested in the subagent's run, or at the top level
// when that run is not in the history (a fork cut it off).
type TextItem struct {
	Content         string `json:"content,omitempty"`
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
}

// ThinkingItem is one finished stretch of thinking; see agent.ThinkingRecord.
type ThinkingItem struct {
	Content         string `json:"content,omitempty"`
	FullReasoning   string `json:"full_reasoning,omitempty"`
	Redacted        bool   `json:"redacted,omitempty"`
	DurationMs      int64  `json:"duration_ms,omitempty"`
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
}

// ToolItem is one tool run (Item) as it stands, with everything run inside
// it — a subagent's words, thinking and calls — as items of its own, in the
// order they came.
type ToolItem struct {
	// ToolUseID is empty only for a permission request that named no call.
	ToolUseID string          `json:"tool_use_id,omitempty"`
	ToolName  string          `json:"tool_name,omitempty"`
	ToolInput json.RawMessage `json:"tool_input,omitempty"`
	// ParentToolUseID is the subagent call this one ran inside. Set on a
	// nested item, and on one at the top level whose parent is not in the
	// history.
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
	// OriginToolUseID is the earlier call this one reads or stops the task of.
	OriginToolUseID string     `json:"origin_tool_use_id,omitempty"`
	Status          ItemStatus `json:"status"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	EndedAt         *time.Time `json:"ended_at,omitempty"`

	Permission        *Permission `json:"permission,omitempty"`
	Result            *Result     `json:"result,omitempty"`
	Backgrounded      bool        `json:"backgrounded,omitempty"`
	Placeholder       string      `json:"placeholder,omitempty"`
	LostWithProcess   bool        `json:"lost_with_process,omitempty"`
	FinishedAfterStop bool        `json:"finished_after_stop,omitempty"`
	Plan              *PlanItem   `json:"plan,omitempty"`
	Children          []PageItem  `json:"children,omitempty"`
}

// PlanItem is a plan as one plan record stated it; see agent.PlanRecord.
type PlanItem struct {
	Steps       []agent.PlanStep `json:"steps,omitempty"`
	Explanation string           `json:"explanation,omitempty"`
	PlanID      string           `json:"plan_id,omitempty"`
	// ToolUseID is the call it was filed on, when that call is not in the
	// history (a fork cut it off); a plan on a call that is rides on its item.
	ToolUseID       string `json:"tool_use_id,omitempty"`
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
}

// ReadItem is a read point: the agent picked up the message MessageID names.
type ReadItem struct {
	MessageID  string     `json:"message_id,omitempty"`
	ObservedAt *time.Time `json:"observed_at,omitempty"`
}

// NoteItem is a line with nothing but its text: a system frame, CLI output
// that could not be parsed, a local command's output.
type NoteItem struct {
	Content string `json:"content,omitempty"`
}

// WarningItem is a non-fatal problem; see agent.WarningRecord.
type WarningItem struct {
	Message     string             `json:"message,omitempty"`
	Code        string             `json:"code,omitempty"`
	AuthFailure *agent.AuthFailure `json:"auth_failure,omitempty"`
	UsageLimit  *agent.UsageLimit  `json:"usage_limit,omitempty"`
}

// ErrorItem is what a failed turn reported; see agent.ErrorRecord.
type ErrorItem struct {
	Error       string             `json:"error,omitempty"`
	AuthFailure *agent.AuthFailure `json:"auth_failure,omitempty"`
	UsageLimit  *agent.UsageLimit  `json:"usage_limit,omitempty"`
	ObservedAt  *time.Time         `json:"observed_at,omitempty"`
}

func (p *Projection) currentPlan() *PageItem {
	plan := p.state.Plan
	if plan == nil {
		return nil
	}
	return &PageItem{Kind: KindPlan, Seq: plan.Seq, LastSeq: plan.Seq, Plan: planItem(plan.Record, "")}
}

// Page is the newest items older than beforeSeq, spending a budget of limit
// records.
//
// beforeSeq is exclusive: NoHistorySeq asks for the newest page, and any
// other value — a cursor a page handed out — for the items that precede the
// one it names. It cannot be past the newest record. limit of zero means
// DefaultPageSize; anything above MaxPageSize is clamped.
//
// The budget counts the records that went into each item, a tool run's
// nested work included, and a page ends on the item that spends it. An item is
// never split, so a page holds at least one, however many records it took.
func (p *Projection) Page(beforeSeq session.HistorySeq, limit int) (Page, error) {
	return p.settledView().page(beforeSeq, limit)
}

func (p *Projection) page(beforeSeq session.HistorySeq, limit int) (Page, error) {
	if limit < 0 {
		return Page{}, fmt.Errorf("%w: limit %d is negative", ErrInvalidLimit, limit)
	}
	if limit == 0 {
		limit = DefaultPageSize
	}
	limit = min(limit, MaxPageSize)

	top := p.topLevel()
	end := len(top)
	if beforeSeq != session.NoHistorySeq {
		if !beforeSeq.Valid() {
			return Page{}, fmt.Errorf("%w: seq %d is not a record address", ErrInvalidCursor, beforeSeq)
		}
		if beforeSeq > p.t.lastSeq {
			return Page{}, fmt.Errorf("%w: seq %d is past the newest record, seq %d",
				ErrInvalidCursor, beforeSeq, p.t.lastSeq)
		}
		end = sort.Search(len(top), func(i int) bool { return p.t.entries[top[i]].pos >= beforeSeq })
	}

	start, spent := end, 0
	for start > 0 && spent < limit {
		start--
		spent += p.weight(top[start])
	}
	// The cursor is the first item's seq, and an item in no file has none of
	// its own: it goes with the numbered item before it.
	for start > 0 && !p.t.entries[top[start]].numbered {
		start--
	}
	// Nor can it start inside the items one record made (a legacy
	// ask_user_question asking several): the cursor would be that record's
	// seq, and the next page would end before all of them.
	for start > 0 && p.t.entries[top[start-1]].pos == p.t.entries[top[start]].pos {
		start--
	}

	page := Page{Turns: []PageTurn{}, ThroughSeq: p.t.lastSeq, Plan: p.currentPlan()}
	if start > 0 {
		page.HasMore = true
		page.NextBeforeSeq = p.t.entries[top[start]].pos
	}
	for i := start; i < end; i++ {
		e := p.t.entries[top[i]]
		n := len(page.Turns)
		if n == 0 || page.Turns[n-1].index != e.turn {
			page.Turns = append(page.Turns, p.pageTurn(e.turn, i > 0 && p.t.entries[top[i-1]].turn == e.turn && e.turn >= 0))
			n++
		}
		page.Turns[n-1].Items = append(page.Turns[n-1].Items, p.pageItem(top[i]))
	}
	return page, nil
}

func (p *Projection) pageTurn(turn int, continued bool) PageTurn {
	stretch := PageTurn{Items: []PageItem{}, index: turn, Continued: continued}
	if turn < 0 {
		return stretch
	}
	t := p.state.Turns[turn]
	stretch.Turn = &t
	for _, d := range p.state.Discarded {
		if d.TurnID == t.ID {
			stretch.Discarded = append(stretch.Discarded, d)
		}
	}
	return stretch
}

// topLevel is the entries a page lists, in order: all but those nested in a
// tool run the history holds.
func (p *Projection) topLevel() []int {
	top := make([]int, 0, len(p.t.entries))
	for i := range p.t.entries {
		if !p.nested(i) {
			top = append(top, i)
		}
	}
	return top
}

func (p *Projection) parentOf(i int) string {
	e := p.t.entries[i]
	if e.kind == KindTool {
		return p.state.Items[e.ref].ParentToolUseID
	}
	return e.parent
}

func (p *Projection) nested(i int) bool {
	parent := p.parentOf(i)
	if parent == "" {
		return false
	}
	_, ok := p.items.byToolUse[parent]
	return ok
}

// childrenOf are the entries nested in tool run entry i, in order.
func (p *Projection) childrenOf(i int) []int {
	e := p.t.entries[i]
	if e.kind != KindTool {
		return nil
	}
	id := p.state.Items[e.ref].ToolUseID
	if id == "" {
		return nil
	}
	var children []int
	for _, c := range p.t.children[id] {
		if p.parentOf(c) == id {
			children = append(children, c)
		}
	}
	slices.Sort(children)
	return slices.Compact(children)
}

func (p *Projection) weight(i int) int {
	w := p.t.entries[i].records
	for _, c := range p.childrenOf(i) {
		w += p.weight(c)
	}
	return w
}

// pageItem is entry i as a page carries it, the work nested in it included.
func (p *Projection) pageItem(i int) PageItem {
	return p.entryItem(i, true)
}

// entryItem is entry i as an item. withChildren says whether a tool run carries
// the items nested in it; its LastSeq counts theirs either way.
func (p *Projection) entryItem(i int, withChildren bool) PageItem {
	e := p.t.entries[i]
	out := PageItem{ID: i + 1, Kind: e.kind, LastSeq: e.last}
	if e.numbered {
		out.Seq = e.pos
	}
	switch e.kind {
	case KindTool:
		out.Tool = p.toolItem(i, withChildren)
		if withChildren {
			for _, c := range out.Tool.Children {
				out.LastSeq = max(out.LastSeq, c.LastSeq)
			}
		} else {
			out.LastSeq = p.subtreeLast(i)
		}
	case KindQuestion:
		q := p.state.Questions[e.ref]
		out.Question = &q
	case KindMessage:
		r := e.record.(agent.MessageRecord)
		out.Message = &MessageItem{
			MessageID:   r.MessageID,
			Content:     r.Content,
			ObservedAt:  r.ObservedAt,
			Origin:      r.Origin,
			Subtype:     r.Subtype,
			Meta:        r.Meta,
			Answering:   r.Answering,
			Command:     r.Command,
			HTMLAction:  r.HTMLAction,
			Attachments: r.Attachments,
			Discarded:   e.discarded,
		}
	case KindText:
		r := e.record.(agent.TextRecord)
		out.Text = &TextItem{Content: r.Content, ParentToolUseID: r.ParentToolUseID}
	case KindThinking:
		r := e.record.(agent.ThinkingRecord)
		out.Thinking = &ThinkingItem{
			Content:         r.Content,
			FullReasoning:   r.FullReasoning,
			Redacted:        r.Redacted,
			DurationMs:      r.DurationMs,
			ParentToolUseID: r.ParentToolUseID,
		}
	case KindPlan:
		r := e.record.(agent.PlanRecord)
		out.Plan = planItem(r, r.ToolUseID)
	case KindRead:
		r := e.record.(agent.MessageIngestedRecord)
		out.Read = &ReadItem{MessageID: r.MessageID, ObservedAt: r.ObservedAt}
	case KindSystem:
		out.System = &NoteItem{Content: e.record.(agent.SystemRecord).Content}
	case KindRaw:
		out.Raw = &NoteItem{Content: e.record.(agent.RawRecord).Content}
	case KindCommandOutput:
		out.CommandOutput = &NoteItem{Content: e.record.(agent.CommandOutputRecord).Content}
	case KindWarning:
		out.Warning = UnrecordedWarning(e.record.(agent.WarningRecord)).Warning
	case KindError:
		r := e.record.(agent.ErrorRecord)
		out.Error = &ErrorItem{Error: r.Error, AuthFailure: r.AuthFailure, UsageLimit: r.UsageLimit, ObservedAt: r.ObservedAt}
	}
	return out
}

// subtreeLast is the newest record that went into entry i or anything
// nested in it.
func (p *Projection) subtreeLast(i int) session.HistorySeq {
	return p.t.entries[i].subtreeLast
}

func (p *Projection) toolItem(i int, withChildren bool) *ToolItem {
	item := p.state.Items[p.t.entries[i].ref]
	out := &ToolItem{
		ToolUseID:         item.ToolUseID,
		ToolName:          item.ToolName,
		ToolInput:         item.ToolInput,
		ParentToolUseID:   item.ParentToolUseID,
		OriginToolUseID:   item.OriginToolUseID,
		Status:            item.Status,
		StartedAt:         item.StartedAt,
		EndedAt:           item.EndedAt,
		Permission:        item.Permission,
		Result:            item.Result,
		Backgrounded:      item.Backgrounded,
		Placeholder:       item.Placeholder,
		LostWithProcess:   item.LostWithProcess,
		FinishedAfterStop: item.FinishedAfterStop,
	}
	if item.Plan != nil {
		out.Plan = planItem(*item.Plan, "")
	}
	if withChildren {
		for _, c := range p.childrenOf(i) {
			out.Children = append(out.Children, p.pageItem(c))
		}
	}
	return out
}

// UnrecordedWarning is the item of a warning that is in no history: the one
// standing in for a record that could not be written
// (chatstream.HistoryWriteFailedCode). It has no id and no seq, and nothing
// ever updates it; a reload no longer shows it, as there is nothing to read
// it from.
func UnrecordedWarning(r agent.WarningRecord) PageItem {
	return PageItem{Kind: KindWarning, Warning: &WarningItem{Message: r.Message, Code: r.Code, AuthFailure: r.AuthFailure, UsageLimit: r.UsageLimit}}
}

func planItem(r agent.PlanRecord, toolUseID string) *PlanItem {
	return &PlanItem{
		Steps:           r.Steps,
		Explanation:     r.Explanation,
		PlanID:          r.PlanID,
		ToolUseID:       toolUseID,
		ParentToolUseID: r.ParentToolUseID,
	}
}
