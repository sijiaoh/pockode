package work

import "fmt"

// pockodeMCPPrefix grounds the agent in Pockode's tool namespace,
// preventing confusion with tools from other MCP servers.
const pockodeMCPPrefix = "All work_* and agent_role_* tools in this session belong to Pockode's project management system. Use them exactly as described below."

func roleReference(agentRoleID string) string {
	return fmt.Sprintf(
		"Your agent role ID is %s. Use agent_role_get with this ID to retrieve your role instructions.",
		agentRoleID,
	)
}

const storyBehaviorRules = `You are a COORDINATOR for this story. Follow these rules strictly:
1. Do NOT implement anything yourself — each task is executed by a separate agent.
2. Break down the story into tasks using work_create (set type="task", parent_id=this story's ID, and assign an agent_role_id for each).
3. After creating all tasks, call work_done on YOUR story immediately. Do NOT wait for tasks to finish — you will be automatically reactivated when a task completes.
4. Do NOT call work_done on child tasks; task agents handle their own lifecycle.`

// buildBase builds the common message shared by all prompt types.
func buildBase(w Work) string {
	role := roleReference(w.AgentRoleID)

	workCtx := fmt.Sprintf("You are working on: %q (Work ID: %s). Use work_get with this ID to read the full details before starting.", w.Title, w.ID)

	var rules string
	if w.Type == WorkTypeStory {
		rules = fmt.Sprintf(
			"%s\nCall work_done with ID %s as soon as you've created the tasks. If you need user input to proceed, call work_needs_input with ID %s.",
			storyBehaviorRules, w.ID, w.ID,
		)
	} else {
		if w.ParentID != "" {
			rules = fmt.Sprintf(
				"Before starting, use work_comment_list with work_id %s to check for any instructions or feedback on the parent story.\n\nIMPORTANT: When you finish, you MUST first report your results by calling work_comment_add with work_id %s (the parent), then call work_done with ID %s. If you need user input to proceed, call work_needs_input with ID %s. Do not end your turn without calling one of these.",
				w.ParentID, w.ParentID, w.ID, w.ID,
			)
		} else {
			rules = fmt.Sprintf(
				"IMPORTANT: When you finish, you MUST call work_done with ID %s. If you need user input to proceed, call work_needs_input with ID %s. Do not end your turn without calling one of these.",
				w.ID, w.ID,
			)
		}
	}

	return pockodeMCPPrefix + "\n\n" + role + "\n\n" + workCtx + "\n\n" + rules
}

func BuildKickoffMessage(w Work) string {
	return buildBase(w)
}

// BuildRestartMessage appends a restart nudge to the base message
// when a stopped work item is restarted by the user.
func BuildRestartMessage(w Work) string {
	base := buildBase(w)

	var nudge string
	if w.Type == WorkTypeStory {
		nudge = fmt.Sprintf(
			"Your story was stopped and is now being restarted. Review your tasks, then call work_done with ID %s. You will be reactivated when a task completes.",
			w.ID,
		)
	} else {
		nudge = fmt.Sprintf(
			"Your task was stopped and is now being restarted. Review what you've done so far, then either complete the remaining work or call work_done with ID %s if everything is finished.",
			w.ID,
		)
	}

	return base + "\n\n" + nudge
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
		"Task %q (ID: %s) has been completed. Use work_comment_list with work_id %s to read the task's report. Then use work_list with parent_id %s to check remaining tasks. If all tasks are done, call work_done with ID %s. If tasks remain, review progress and adjust the plan as needed, then call work_done with ID %s — this returns you to a dormant state until the next task completes.",
		childTitle, childID, childID, parent.ID, parent.ID, parent.ID,
	)

	return base + "\n\n" + nudge
}
