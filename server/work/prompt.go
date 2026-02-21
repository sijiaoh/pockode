package work

import "fmt"

func roleReference(agentRoleID string) string {
	return fmt.Sprintf(
		"Your agent role ID is %s. Use the agent_role_get tool to retrieve your role instructions.",
		agentRoleID,
	)
}

const storyBehaviorRules = "Your ONLY job is to coordinate tasks (create, update, or delete) — do NOT implement anything yourself. Each task will be executed by a separate agent. Do NOT call work_done on tasks — each task agent will mark itself done when finished."

// buildBase builds the common message shared by all prompt types:
// role reference, work context, behavior rules (story only), and done instruction.
func buildBase(w Work) string {
	role := roleReference(w.AgentRoleID)

	workCtx := fmt.Sprintf("You are working on: %q (Work ID: %s)", w.Title, w.ID)
	if w.Body != "" {
		workCtx += "\n\n" + w.Body
	}

	var rules string
	if w.Type == WorkTypeStory {
		rules = storyBehaviorRules + " " + fmt.Sprintf(
			"When you're done coordinating, call work_done with ID %s immediately.",
			w.ID,
		)
	} else {
		rules = fmt.Sprintf(
			"IMPORTANT: When you finish, you MUST call the work_done tool with ID %s. Do not end your turn without doing this.",
			w.ID,
		)
	}

	return role + "\n\n" + workCtx + "\n\n" + rules
}

func BuildKickoffMessage(w Work) string {
	return buildBase(w)
}

// BuildAutoContinuationMessage appends a nudge to the base message
// when an agent process stops but its work item is still in_progress.
func BuildAutoContinuationMessage(w Work) string {
	base := buildBase(w)

	var nudge string
	if w.Type == WorkTypeStory {
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

	return base + "\n\n" + nudge
}

// BuildParentReactivationMessage appends a reactivation nudge to the base message
// when one of a parent story's child tasks completes.
func BuildParentReactivationMessage(parent Work, childTitle, childID string) string {
	base := buildBase(parent)

	nudge := fmt.Sprintf(
		"Task %q (ID: %s) has been completed. Review the remaining tasks, adjust the plan if needed, then mark yourself done.",
		childTitle, childID,
	)

	return base + "\n\n" + nudge
}
