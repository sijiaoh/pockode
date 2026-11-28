package agent

import (
	"bytes"
	"encoding/json"
)

// EventTypePlan is the agent's plan as it stood at one moment; see PlanEvent.
const EventTypePlan EventType = "plan"

// PlanStepStatus is where one step of a plan stands. The values are Claude's
// TodoWrite and Task tools' own; Codex's `inProgress` is mapped onto them.
type PlanStepStatus string

const (
	PlanStepPending    PlanStepStatus = "pending"
	PlanStepInProgress PlanStepStatus = "in_progress"
	PlanStepCompleted  PlanStepStatus = "completed"
)

// PlanStep is one step of a plan record.
type PlanStep struct {
	// ID is the CLI's task id. Only the Claude adapter's fold of its Task tools
	// sets it: that fold is keyed by id, and a seed has to be able to name the
	// tasks the next TaskUpdate touches (StartOptions.PlanSeed).
	ID         string         `json:"id,omitempty"`
	Text       string         `json:"text"`
	ActiveText string         `json:"active_text,omitempty"`
	Status     PlanStepStatus `json:"status"`
}

// PlanEvent is the agent's plan — its checklist — as it stood when the agent
// last stated it. It is an event, never updated afterwards: the newest one is
// the current plan, so nothing has to store one (docs/turn-progress-ui.md §4.6).
//
// Exactly one of ToolUseID and PlanID is set. A Claude plan is the outcome of
// a call and names it; a Codex plan has no call behind it and carries an id of
// its own, so that a client keying its rows by id can key this one too.
type PlanEvent struct {
	// Steps is the whole plan, in order. Empty is a plan with nothing left in
	// it (every task deleted, an empty TodoWrite), which is still a plan
	// update; the record then carries no steps field at all.
	Steps []PlanStep
	// Explanation is Codex's note on why the plan changed, when it gave one.
	Explanation string
	// ToolUseID is the main-thread Claude call this plan came out of: the plan
	// call itself, or for a subagent's Task call — the task list is the
	// session's, not the subagent's — the top-level subagent call it ran
	// inside.
	ToolUseID string
	// PlanID is a Codex plan's own id, `<turnId>:plan:<n>`, n counting the
	// turn's plan updates from 1.
	PlanID string
	// ParentToolUseID names the subagent a Codex child thread's plan belongs
	// to. Claude writes none: its subagents' TodoWrite lists are not read, and
	// their Task calls change the main plan.
	ParentToolUseID string
	// ProviderMessageID is what the event's neighbours carry; see
	// TextRecord.ProviderMessageID.
	ProviderMessageID string
}

func (PlanEvent) EventType() EventType { return EventTypePlan }
func (PlanEvent) isAgentEvent()        {}

func (e PlanEvent) ToRecord() PlanRecord {
	return PlanRecord{
		Steps:             e.Steps,
		Explanation:       e.Explanation,
		ToolUseID:         e.ToolUseID,
		PlanID:            e.PlanID,
		ParentToolUseID:   e.ParentToolUseID,
		ProviderMessageID: e.ProviderMessageID,
	}
}

func (e PlanEvent) Encode() Wire { return e.ToRecord() }

// LatestPlanSeed is the StartOptions.PlanSeed a session's history holds: the
// steps of its newest main-thread plan record, when that record is a snapshot
// of the Claude adapter's Task-tool fold. Nil otherwise — a session with no
// plan, or one whose newest plan is a TodoWrite list, which has no task ids to
// seed a fold with. records is the whole history, oldest first.
func LatestPlanSeed(records []json.RawMessage) []PlanStep {
	for i := len(records) - 1; i >= 0; i-- {
		// Cheap enough to skip decoding every record of a long history; a
		// record that merely mentions the word is decoded and passed over.
		if !bytes.Contains(records[i], []byte(`"plan"`)) {
			continue
		}
		rec, err := DecodeRecord(records[i])
		if err != nil {
			continue
		}
		record, ok := rec.(PlanRecord)
		if !ok || record.ToolUseID == "" || record.ParentToolUseID != "" {
			continue
		}
		for _, step := range record.Steps {
			if step.ID == "" {
				return nil
			}
		}
		return record.Steps
	}
	return nil
}
