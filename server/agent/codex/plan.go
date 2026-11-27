package codex

import (
	"encoding/json"
	"fmt"

	"github.com/pockode/server/agent"
)

// handlePlanUpdated records the checklist the model keeps with update_plan.
// Codex sends the whole plan each time, so every notification is one plan
// record as it stands (docs/turn-progress-ui.md §4.6).
//
// A plan has no call behind it, so the record carries an id of its own,
// numbered per turn. A child thread's plan is its subagent's and names the
// spawn; one whose spawn this process never saw is dropped, because without
// its owner it would read as the session's own plan.
func (s *appSession) handlePlanUpdated(params json.RawMessage) {
	var notif struct {
		ThreadID    string  `json:"threadId"`
		TurnID      string  `json:"turnId"`
		Explanation *string `json:"explanation"`
		Plan        []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"plan"`
	}
	if err := json.Unmarshal(params, &notif); err != nil || notif.TurnID == "" {
		s.log.Warn("failed to parse turn/plan/updated; the plan update is not recorded", "error", err)
		return
	}

	event := agent.PlanEvent{}
	if s.isOwnThread(notif.ThreadID) {
		event.ProviderMessageID = notif.TurnID
	} else {
		spawn, seen := s.subagentCalls[notif.ThreadID]
		if !seen {
			s.log.Debug("dropping the plan of a subagent whose spawn was not seen", "threadId", notif.ThreadID)
			return
		}
		event.ParentToolUseID = spawn.CallID
	}

	if s.planUpdates == nil {
		s.planUpdates = map[string]int{}
	}
	s.planUpdates[notif.TurnID]++
	event.PlanID = fmt.Sprintf("%s:plan:%d", notif.TurnID, s.planUpdates[notif.TurnID])
	if notif.Explanation != nil {
		event.Explanation = *notif.Explanation
	}
	for _, step := range notif.Plan {
		event.Steps = append(event.Steps, agent.PlanStep{Text: step.Step, Status: planStepStatus(step.Status)})
	}
	s.emitEvent(event)
}

// planStepStatus maps Codex's TurnPlanStepStatus onto the record's. The other
// two values are spelled the same.
func planStepStatus(status string) agent.PlanStepStatus {
	if status == "inProgress" {
		return agent.PlanStepInProgress
	}
	return agent.PlanStepStatus(status)
}

// forgetPlanUpdates drops the plan count of a turn that has ended.
func (s *appSession) forgetPlanUpdates(params json.RawMessage) {
	var notif struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(params, &notif) == nil {
		delete(s.planUpdates, notif.Turn.ID)
	}
}
