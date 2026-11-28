package projection

import (
	"encoding/json"
	"slices"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// ItemStatus is where a tool run stands.
type ItemStatus string

const (
	// ItemRunning is a call the engine is working on.
	ItemRunning ItemStatus = "running"
	// ItemAwaitingPermission is a call held back on a permission request
	// nobody has answered: nothing about it runs while someone decides.
	ItemAwaitingPermission ItemStatus = "awaiting_permission"
	// ItemBackground is a call that handed back a placeholder and goes on
	// working after its turn; its outcome is still to come.
	ItemBackground ItemStatus = "background"
	ItemSucceeded  ItemStatus = "succeeded"
	ItemFailed     ItemStatus = "failed"
	// ItemInterrupted is a call nothing will report on any more: its turn was
	// cut short, its subagent settled under it, or its process went away.
	ItemInterrupted ItemStatus = "interrupted"
	// ItemDenied is a call refused permission, before the engine reported the
	// refusal as its result.
	ItemDenied ItemStatus = "denied"
	// ItemExpired is a call whose permission request stopped waiting without
	// an answer, so it never ran.
	ItemExpired ItemStatus = "expired"
)

// Item is one tool run: everything the history says about one call, from the
// records that name it — its call, its permission request and the answer, its
// result or results, the plan it carries — folded into where it stands now.
type Item struct {
	// ToolUseID names the call. Empty only for a permission request recorded
	// without one, which names no call and is an item of its own.
	ToolUseID string
	ToolName  string
	// ToolInput is the call's input, normalized (normalizeToolInput).
	ToolInput json.RawMessage
	// ParentToolUseID is the subagent call this one ran inside, "" for the
	// main conversation. It may name a call this history does not hold (a
	// fork cut); then the item is a root all the same.
	ParentToolUseID string
	// Children are the tool use ids of the calls run inside this one, in the
	// order they were made: the subagent's own tool runs.
	Children []string
	// OriginToolUseID is the earlier call this one reads or stops the task of
	// (agent.ToolCallRecord.OriginToolUseID).
	OriginToolUseID string
	// TurnID and Seq are where the item first appears: its call, or the
	// permission request that came before it.
	TurnID string
	Seq    session.HistorySeq

	Status ItemStatus
	// StartedAt is when the call started running: an allowed call's answer,
	// otherwise its call record. Nil when nothing recorded the moment, and for
	// a call that never ran.
	StartedAt *time.Time
	// EndedAt is the moment of the result that settled it.
	EndedAt *time.Time

	Permission *Permission
	// Result is the newest result; a background outcome replaces the
	// placeholder, which stays in Placeholder.
	Result *Result
	// Backgrounded says the call's work went on past its turn
	// (agent.ToolResultBackgroundStarted, or a background outcome).
	Backgrounded bool
	Placeholder  string
	// LostWithProcess says the process running the backgrounded work went
	// away before it finished.
	LostWithProcess bool
	// FinishedAfterStop says the engine let an interrupted call run on, and it
	// finished: the status stays what the turn did to it.
	FinishedAfterStop bool
	// Plan is the newest plan record filed on this call
	// (agent.PlanRecord.ToolUseID).
	Plan *agent.PlanRecord
}

// PermissionStatus is where a permission request stands.
type PermissionStatus string

const (
	PermissionPending PermissionStatus = "pending"
	PermissionAllowed PermissionStatus = "allowed"
	PermissionDenied  PermissionStatus = "denied"
	// PermissionExpired is a request that stopped waiting unanswered.
	PermissionExpired PermissionStatus = "expired"
)

// Permission is the permission request a call was held on and what became of
// it.
type Permission struct {
	RequestID      string
	Suggestions    []agent.PermissionUpdate
	DecisionReason string
	BlockedPath    string
	Seq            session.HistorySeq

	Status PermissionStatus
	Choice agent.PermissionChoiceName
	// By and Review are who answered when it was not a person.
	By     agent.PermissionResponder
	Review *agent.PermissionReview
	// Always says a person answered Always Allow.
	Always     bool
	AnsweredAt *time.Time
	// Reason is why an expired request stopped waiting, when a record said.
	Reason agent.CancelReason
}

// Result is what a call came back with.
type Result struct {
	Text       string
	Contents   []agent.ContentBlock
	IsError    bool
	Subtype    agent.ToolResultSubtype
	DurationMs int64
	ExitCode   *int
	Subagent   *agent.SubagentReport
	HTMLPage   string
	WorkRef    *agent.WorkRef
	ObservedAt *time.Time
	Seq        session.HistorySeq
}

// Item is the tool run toolUseID names.
func (s State) Item(toolUseID string) (Item, bool) {
	if toolUseID == "" {
		return Item{}, false
	}
	for _, item := range s.Items {
		if item.ToolUseID == toolUseID {
			return item, true
		}
	}
	return Item{}, false
}

type toolCalled struct{ call agent.ToolCallRecord }

type toolReturned struct{ result agent.ToolResultRecord }

type permissionAsked struct{ request agent.PermissionRequestRecord }

type permissionAnswered struct {
	response agent.PermissionResponseRecord
}

// permissionWithdrawn is a request_cancelled, which names a question or a
// permission request: the request id says which.
type permissionWithdrawn struct {
	requestID string
	reason    agent.CancelReason
}

// processEnded is the process going away, whether or not a turn was open: it
// took every pending request and every call still running with it.
type processEnded struct{}

func (toolCalled) isFact()          {}
func (toolReturned) isFact()        {}
func (permissionAsked) isFact()     {}
func (permissionAnswered) isFact()  {}
func (permissionWithdrawn) isFact() {}
func (processEnded) isFact()        {}

// itemIndex finds items by what the records name them by.
type itemIndex struct {
	// byToolUse indexes State.Items by tool use id.
	byToolUse map[string]int
	// byRequest indexes them by permission request id.
	byRequest map[string]int
	// waiting are, by parent tool use id, the calls that named a parent not
	// in the history yet, adopted when it is.
	waiting map[string][]string
}

func newItemIndex() itemIndex {
	return itemIndex{byToolUse: map[string]int{}, byRequest: map[string]int{}, waiting: map[string][]string{}}
}

func (x itemIndex) clone() itemIndex {
	waiting := make(map[string][]string, len(x.waiting))
	for id, children := range x.waiting {
		waiting[id] = slices.Clone(children)
	}
	return itemIndex{byToolUse: cloneMap(x.byToolUse), byRequest: cloneMap(x.byRequest), waiting: waiting}
}

func cloneMap(m map[string]int) map[string]int {
	c := make(map[string]int, len(m))
	for k, v := range m {
		c[k] = v
	}
	return c
}

func (p *Projection) item(toolUseID string) (*Item, bool) {
	if toolUseID == "" {
		return nil, false
	}
	i, ok := p.items.byToolUse[toolUseID]
	if !ok {
		return nil, false
	}
	return &p.state.Items[i], true
}

func (p *Projection) addItem(item Item) int {
	i := len(p.state.Items)
	p.state.Items = append(p.state.Items, item)
	if item.ToolUseID != "" {
		p.items.byToolUse[item.ToolUseID] = i
		if children, ok := p.items.waiting[item.ToolUseID]; ok {
			p.state.Items[i].Children = children
			delete(p.items.waiting, item.ToolUseID)
		}
	}
	return i
}

// nest files the item under the call it names as its parent: as that call's
// child once it is in the history, which it need not be yet. A parent the item
// is itself an ancestor of is no parent — a cycle would leave both unsettled
// for good — and the item stays a root.
func (p *Projection) nest(item *Item, parentToolUseID string) {
	if item.ParentToolUseID != "" || parentToolUseID == "" || p.isAncestor(item.ToolUseID, parentToolUseID) {
		return
	}
	item.ParentToolUseID = parentToolUseID
	if parent, ok := p.item(parentToolUseID); ok {
		parent.Children = append(parent.Children, item.ToolUseID)
	} else {
		p.items.waiting[parentToolUseID] = append(p.items.waiting[parentToolUseID], item.ToolUseID)
	}
}

// isAncestor says id is toolUseID or a call it ran inside.
func (p *Projection) isAncestor(id, toolUseID string) bool {
	for toolUseID != "" {
		if toolUseID == id {
			return true
		}
		item, ok := p.item(toolUseID)
		if !ok {
			return false
		}
		toolUseID = item.ParentToolUseID
	}
	return false
}

func (p *Projection) applyItem(f fact, line agent.InferredLine) {
	switch f := f.(type) {
	case toolCalled:
		p.toolCalled(f.call, line)
	case toolReturned:
		p.toolReturned(f.result, line)
	case permissionAsked:
		p.permissionAsked(f.request, line)
	case permissionAnswered:
		p.permissionAnswered(f.response)
	case permissionWithdrawn:
		p.permissionExpired(f.requestID, f.reason)
	case processEnded:
		for requestID := range p.items.byRequest {
			p.permissionExpired(requestID, agent.ReasonProcessEnded)
		}
		p.settleRunning(true)
	case planStated:
		if item, ok := p.item(f.plan.ToolUseID); ok {
			plan := f.plan
			item.Plan = &plan
		}
	}
}

func (p *Projection) toolCalled(call agent.ToolCallRecord, line agent.InferredLine) {
	if call.ToolUseID == "" {
		// Nothing to join its result or its request to: history old enough
		// to predate the id on every adapter.
		return
	}
	item, known := p.item(call.ToolUseID)
	if call.Subtype == agent.ToolCallResumed {
		// The run it already has, running again; a call this history never
		// saw made is not one to start here.
		// One still held on its request has nothing running to resume.
		if known && item.Status != ItemRunning && item.Status != ItemBackground && item.Status != ItemAwaitingPermission {
			item.Status, item.StartedAt, item.EndedAt = ItemRunning, call.ObservedAt, nil
			if item.Result != nil {
				result := *item.Result
				result.DurationMs = 0
				item.Result = &result
			}
		}
		return
	}
	if known {
		// A resend, or the call announced after the request that held it:
		// it says what the call does and whose it is, and leaves where the run
		// stands alone.
		item.ToolName, item.ToolInput = call.ToolName, call.ToolInput
		if call.OriginToolUseID != "" {
			item.OriginToolUseID = call.OriginToolUseID
		}
		if item.Permission != nil && item.Permission.Status == PermissionAllowed && item.StartedAt == nil {
			item.StartedAt = call.ObservedAt
		}
		p.nest(item, call.ParentToolUseID)
		return
	}
	item = &p.state.Items[p.addItem(Item{
		ToolUseID:       call.ToolUseID,
		ToolName:        call.ToolName,
		ToolInput:       call.ToolInput,
		OriginToolUseID: call.OriginToolUseID,
		TurnID:          line.Turn.ID(),
		Seq:             line.Seq,
		Status:          ItemRunning,
		StartedAt:       call.ObservedAt,
	})]
	p.nest(item, call.ParentToolUseID)
	if p.bornSettled(item) {
		item.Status = ItemInterrupted
	}
}

// bornSettled says a call is trailing in after nothing is left to report on
// it: the subagent it ran inside was cut short or failed, with no turn begun
// since that could have resumed it; or its turn was cut short — the agent's
// output outlives a Stop — and it is the main agent's, or its subagent was
// still running then. A subagent that had finished is another matter: Claude
// resumes one the agent writes to, and its resumed work is still to report.
// Under backgrounded work a call lives on, as that work does.
func (p *Projection) bornSettled(item *Item) bool {
	if p.underBackground(item) {
		return false
	}
	parent, nested := p.item(item.ParentToolUseID)
	if nested && (parent.Status == ItemInterrupted || parent.Status == ItemFailed) &&
		p.settledIn[parent.ToolUseID] == len(p.state.Turns) {
		return true
	}
	n := len(p.state.Turns)
	turnCut := p.openTurn < 0 && n > 0 && p.state.Turns[n-1].Ended &&
		p.state.Turns[n-1].Outcome != session.OutcomeCompleted
	return turnCut && (!nested || parent.Status == ItemRunning)
}

func (p *Projection) underBackground(item *Item) bool {
	seen := map[string]bool{}
	for id := item.ParentToolUseID; id != "" && !seen[id]; {
		seen[id] = true
		parent, ok := p.item(id)
		if !ok {
			return false
		}
		if parent.Status == ItemBackground {
			return true
		}
		id = parent.ParentToolUseID
	}
	return false
}

func (p *Projection) toolReturned(rec agent.ToolResultRecord, line agent.InferredLine) {
	item, ok := p.item(rec.ToolUseID)
	if !ok {
		// An orphan: its call is not in this history.
		return
	}
	result := &Result{
		Text:       rec.ToolResult,
		Contents:   rec.Contents,
		IsError:    rec.IsError,
		Subtype:    rec.Subtype,
		DurationMs: rec.DurationMs,
		ExitCode:   rec.ExitCode,
		Subagent:   rec.Subagent,
		HTMLPage:   rec.HTMLPage,
		WorkRef:    rec.WorkRef,
		ObservedAt: rec.ObservedAt,
		Seq:        line.Seq,
	}
	// What only some results report carries over from the one before: a
	// background outcome says everything its placeholder did, and more.
	if prev := item.Result; prev != nil {
		if result.Subagent == nil {
			result.Subagent = prev.Subagent
		}
		if result.ExitCode == nil {
			result.ExitCode = prev.ExitCode
		}
		if result.HTMLPage == "" {
			result.HTMLPage = prev.HTMLPage
		}
		if result.WorkRef == nil {
			result.WorkRef = prev.WorkRef
		}
		if result.DurationMs == 0 {
			result.DurationMs = prev.DurationMs
		}
	}
	interrupted := item.Status == ItemInterrupted

	if rec.Subtype == agent.ToolResultBackgroundStarted {
		item.Result, item.Placeholder, item.Backgrounded = result, rec.ToolResult, true
		if !interrupted {
			item.Status = ItemBackground
		}
		return
	}

	item.Result, item.EndedAt = result, rec.ObservedAt
	switch {
	case interrupted:
		item.FinishedAfterStop = !rec.IsError && rec.Subtype != agent.ToolResultBackgroundLost
	case rec.IsError:
		item.Status = ItemFailed
	default:
		item.Status = ItemSucceeded
	}
	if rec.Subtype.SettlesBackgroundWork() {
		// Said by the outcome itself: a task can be backdated into the
		// background after its placeholder was recorded.
		item.Backgrounded = true
		if rec.Subtype == agent.ToolResultBackgroundLost {
			item.LostWithProcess = true
		}
	}
	p.settledIn[item.ToolUseID] = len(p.state.Turns)
	// A settled subagent leaves nothing running under it. Its backgrounded
	// work is left to its own outcome, unless the process that would send
	// one is gone.
	p.settleChildren(item, rec.Subtype == agent.ToolResultBackgroundLost)
}

func (p *Projection) permissionAsked(req agent.PermissionRequestRecord, line agent.InferredLine) {
	if req.RequestID == "" {
		return
	}
	if _, dup := p.items.byRequest[req.RequestID]; dup {
		// The CLI re-sends a request it has had no answer to.
		return
	}
	permission := &Permission{
		RequestID:      req.RequestID,
		Suggestions:    req.PermissionSuggestions,
		DecisionReason: req.DecisionReason,
		BlockedPath:    req.BlockedPath,
		Seq:            line.Seq,
		Status:         PermissionPending,
	}
	i, ok := p.items.byToolUse[req.ToolUseID]
	if !ok || req.ToolUseID == "" {
		// Asked before its call was announced — Codex asks first, and so does
		// a Claude subagent — or about no call at all.
		i = p.addItem(Item{
			ToolUseID: req.ToolUseID,
			ToolName:  req.ToolName,
			ToolInput: req.ToolInput,
			TurnID:    line.Turn.ID(),
			Seq:       line.Seq,
			Status:    ItemAwaitingPermission,
		})
	} else if item := &p.state.Items[i]; item.Result == nil && item.Status != ItemBackground && item.Status != ItemInterrupted {
		// Held back again, or asked again after an earlier request expired
		// or was denied: nothing runs until this one is answered.
		item.Status, item.StartedAt = ItemAwaitingPermission, nil
	}
	p.state.Items[i].Permission = permission
	p.items.byRequest[req.RequestID] = i
}

// permissionAnswered settles a request with its answer. A person's answer
// moves only a pending request. One naming who gave it — a reviewer's, or
// Pockode's own — is the answer the server took, and stands over a person's
// recorded beside it (first answer wins on the server; the person's press
// was the one refused).
func (p *Projection) permissionAnswered(rec agent.PermissionResponseRecord) {
	item, prev, ok := p.request(rec.RequestID)
	if !ok {
		return
	}
	switch {
	case prev.Status == PermissionExpired:
		return
	case rec.By != "":
		if prev.By != "" {
			return
		}
	case prev.Status != PermissionPending:
		return
	}
	permission := *prev
	permission.Status, permission.Choice = PermissionAllowed, rec.Choice
	if rec.Choice == agent.ChoiceNameDeny {
		permission.Status = PermissionDenied
	}
	permission.By, permission.Review = rec.By, rec.Review
	permission.Always = rec.Choice == agent.ChoiceNameAlwaysAllow && rec.By == ""
	if permission.AnsweredAt == nil {
		permission.AnsweredAt = rec.ObservedAt
	}
	item.Permission = &permission

	// Where the call stands follows only while it was waiting on the answer:
	// a result the engine recorded first already said what happened.
	if item.Status != ItemAwaitingPermission && item.Status != ItemDenied && item.Status != ItemRunning {
		return
	}
	if item.Result != nil {
		return
	}
	if permission.Status == PermissionDenied {
		item.Status, item.StartedAt = ItemDenied, nil
		return
	}
	item.Status, item.StartedAt = ItemRunning, permission.AnsweredAt
}

// permissionExpired retires a request nobody answered. A request already
// expired still takes the reason the first record naming one gives.
func (p *Projection) permissionExpired(requestID string, reason agent.CancelReason) {
	item, prev, ok := p.request(requestID)
	if !ok {
		return
	}
	switch {
	case prev.Status == PermissionPending:
	case prev.Status == PermissionExpired && prev.Reason == "" && reason != "":
	default:
		return
	}
	permission := *prev
	permission.Status, permission.Reason = PermissionExpired, reason
	item.Permission = &permission
	if item.Status == ItemAwaitingPermission {
		item.Status = ItemExpired
	}
}

// request is the item requestID was asked about and its permission, while
// that request is still the item's: a call asked about again under a new id
// carries the newer request, and the older one's records no longer move it.
func (p *Projection) request(requestID string) (*Item, *Permission, bool) {
	i, ok := p.items.byRequest[requestID]
	if !ok {
		return nil, nil, false
	}
	item := &p.state.Items[i]
	if item.Permission == nil || item.Permission.RequestID != requestID {
		return nil, nil, false
	}
	return item, item.Permission, true
}

// settleRunning interrupts every call nothing can report on any more, once a
// turn is cut short or the process is gone. Backgrounded work outlives its
// turn — and everything under it with it — but not its process.
func (p *Projection) settleRunning(processGone bool) {
	for i := range p.state.Items {
		item := &p.state.Items[i]
		if _, nested := p.item(item.ParentToolUseID); nested {
			continue
		}
		p.settleTree(item, processGone)
	}
}

func (p *Projection) settleTree(item *Item, processGone bool) {
	switch item.Status {
	case ItemBackground:
		if !processGone {
			return
		}
		item.Status, item.LostWithProcess = ItemInterrupted, true
		p.settledIn[item.ToolUseID] = len(p.state.Turns)
	case ItemRunning:
		item.Status = ItemInterrupted
		p.settledIn[item.ToolUseID] = len(p.state.Turns)
	}
	p.settleChildren(item, processGone)
}

func (p *Projection) settleChildren(item *Item, processGone bool) {
	for _, id := range item.Children {
		if child, ok := p.item(id); ok {
			p.settleTree(child, processGone)
		}
	}
}

// cloneItems shares nothing the fold changes in place: an item's fields and
// its children. Permissions, results and plans are replaced, never edited.
func cloneItems(items []Item) []Item {
	out := slices.Clone(items)
	for i := range out {
		out[i].Children = slices.Clone(out[i].Children)
	}
	return out
}
