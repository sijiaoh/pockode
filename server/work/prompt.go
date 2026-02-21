package work

import "fmt"

func roleReference(agentRoleID string) string {
	return fmt.Sprintf(
		"Your agent role ID is %s. Use the agent_role_get tool to retrieve your role instructions.",
		agentRoleID,
	)
}

const storyBehaviorRules = "You are a coordinator. Break down the work into tasks using work_create, then call work_done on YOUR story immediately — do NOT wait for tasks to finish. You will be automatically reactivated when a task completes. Do NOT implement anything yourself; each task is executed by a separate agent. Do NOT call work_done on child tasks; task agents handle that themselves."

// buildBase builds the common message shared by all prompt types.
func buildBase(w Work) string {
	role := roleReference(w.AgentRoleID)

	workCtx := fmt.Sprintf("You are working on: %q (Work ID: %s). Use work_get with this ID to read the full details before starting.", w.Title, w.ID)

	var rules string
	if w.Type == WorkTypeStory {
		rules = fmt.Sprintf(
			"%s Call work_done with ID %s as soon as you've created the tasks. If you need user input to proceed, call work_needs_input with ID %s.",
			storyBehaviorRules, w.ID, w.ID,
		)
	} else {
		if w.ParentID != "" {
			rules = fmt.Sprintf(
				"IMPORTANT: When you finish, you MUST first report your results by calling work_comment_add with work_id %s (the parent), then call work_done with ID %s. If you need user input to proceed, call work_needs_input with ID %s. Do not end your turn without calling one of these.",
				w.ParentID, w.ID, w.ID,
			)
		} else {
			rules = fmt.Sprintf(
				"IMPORTANT: When you finish, you MUST call work_done with ID %s. If you need user input to proceed, call work_needs_input with ID %s. Do not end your turn without calling one of these.",
				w.ID, w.ID,
			)
		}
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
			"Your story is still in_progress but your session was interrupted. Review your tasks, then call work_done with ID %s. You will be reactivated when a task completes.",
			w.ID,
		)
	} else {
		nudge = fmt.Sprintf(
			"Your task is still in_progress but your session was interrupted. Review what you've done so far, then either complete the remaining work or call work_done with ID %s if everything is finished.",
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
		"Task %q (ID: %s) has been completed. Use work_comment_list with work_id %s to read the task's report. Then use work_list with parent_id %s to check remaining tasks. If all tasks are done, call work_done with ID %s. If tasks remain, review progress and adjust the plan as needed, then call work_done with ID %s to wait for the next completion.",
		childTitle, childID, parent.ID, parent.ID, parent.ID, parent.ID,
	)

	return base + "\n\n" + nudge
}
