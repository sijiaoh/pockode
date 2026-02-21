package work

import (
	"fmt"
	"strings"
)

// --- shared building blocks ---

func roleReference(agentRoleID string) string {
	return fmt.Sprintf(
		"Your agent role ID is %s. Use the agent_role_get tool to retrieve your role instructions.",
		agentRoleID,
	)
}

const storyBehaviorRules = "Your ONLY job is to coordinate tasks (create, update, or delete) — do NOT implement anything yourself. Each task will be executed by a separate agent. Do NOT call work_done on tasks — each task agent will mark itself done when finished."

func joinParts(parts []string) string {
	return strings.Join(parts, "\n\n")
}

// --- public builders ---

// BuildKickoffMessage builds the prompt sent to an agent when work starts.
// Tasks include parent context; stories instruct the agent to only coordinate.
// The agent role is referenced by ID so the agent can fetch it via agent_role_get.
func BuildKickoffMessage(w Work, parentTitle string) string {
	var body string
	if w.Body != "" {
		body = "\n\n" + w.Body
	}

	role := roleReference(w.AgentRoleID)

	if w.Type == WorkTypeTask && parentTitle != "" {
		workCtx := fmt.Sprintf(
			"You are working on task: %q (Work ID: %s)\nThis is part of: %q%s",
			w.Title, w.ID, parentTitle, body,
		)
		doneRule := fmt.Sprintf(
			"IMPORTANT: When you finish, you MUST call the work_done tool with ID %s. Do not end your turn without doing this.",
			w.ID,
		)
		return role + "\n\n" + workCtx + "\n\n" + doneRule
	}

	workCtx := fmt.Sprintf(
		"You are working on: %q (Work ID: %s)%s",
		w.Title, w.ID, body,
	)
	doneRule := fmt.Sprintf(
		"When you're done coordinating, call work_done with ID %s immediately.",
		w.ID,
	)
	return role + "\n\n" + workCtx + "\n\n" + storyBehaviorRules + " " + doneRule
}

// BuildAutoContinuationMessage creates the nudge sent when an agent process
// stops but its work item is still in_progress.
func BuildAutoContinuationMessage(w Work, parentTitle string) string {
	role := roleReference(w.AgentRoleID)

	var workCtx string
	if w.Type == WorkTypeTask {
		workCtx = fmt.Sprintf(
			"You are working on task: %q (Work ID: %s)",
			w.Title, w.ID,
		)
		if parentTitle != "" {
			workCtx += fmt.Sprintf("\nThis is part of: %q", parentTitle)
		}
	} else {
		workCtx = fmt.Sprintf(
			"You are working on: %q (Work ID: %s)",
			w.Title, w.ID,
		)
	}

	if w.Body != "" {
		workCtx += "\n\n" + w.Body
	}

	var rules, nudge string
	if w.Type == WorkTypeStory {
		rules = storyBehaviorRules
		nudge = fmt.Sprintf(
			"Your story is still in_progress. If you're done coordinating tasks, call work_done with ID %s now.",
			w.ID,
		)
	} else {
		nudge = fmt.Sprintf(
			"Your task is still in_progress. If you've finished, call work_done with ID %s. If not, continue working.",
			w.ID,
		)
	}

	parts := []string{role, workCtx}
	if rules != "" {
		parts = append(parts, rules)
	}
	parts = append(parts, nudge)
	return joinParts(parts)
}

// BuildParentReactivationMessage creates the message sent to a parent story's
// agent when one of its child tasks completes.
func BuildParentReactivationMessage(parent Work, childTitle string) string {
	role := roleReference(parent.AgentRoleID)
	workCtx := fmt.Sprintf(
		"You are working on: %q (Work ID: %s)",
		parent.Title, parent.ID,
	)
	nudge := fmt.Sprintf(
		"Task %q has been completed. Review the remaining tasks, adjust the plan if needed, then call work_done with ID %s.",
		childTitle, parent.ID,
	)
	return joinParts([]string{role, workCtx, storyBehaviorRules, nudge})
}
