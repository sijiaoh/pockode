package work

import "fmt"

// BuildKickoffMessage builds the prompt sent to an agent when work starts.
// Tasks include parent context; stories instruct the agent to only coordinate.
func BuildKickoffMessage(w Work, parentTitle string) string {
	var body string
	if w.Body != "" {
		body = "\n\n" + w.Body
	}

	if w.Type == WorkTypeTask && parentTitle != "" {
		return fmt.Sprintf(
			"You are working on task: %q (Work ID: %s)\nThis is part of: %q%s\n\nIMPORTANT: When you finish, you MUST call the work_done tool with ID %s. Do not end your turn without doing this.",
			w.Title, w.ID, parentTitle, body, w.ID,
		)
	}
	return fmt.Sprintf(
		"You are working on: %q (Work ID: %s)%s\n\nYour ONLY job is to coordinate tasks (create, update, or delete) — do NOT implement anything yourself. Each task will be executed by a separate agent. Do NOT call work_done on tasks — each task agent will mark itself done when finished. When you're done coordinating, call work_done with ID %s immediately.",
		w.Title, w.ID, body, w.ID,
	)
}

// BuildAutoContinuationMessage creates the nudge sent when an agent process
// stops but its work item is still in_progress.
func BuildAutoContinuationMessage(workType WorkType) string {
	if workType == WorkTypeStory {
		return "Your story is still in_progress. If you're done coordinating tasks, call work_done now. Do NOT implement anything yourself."
	}
	return "Your task is still in_progress. If you've finished, call work_done now. If not, continue working."
}

// BuildParentReactivationMessage creates the message sent to a parent story's
// agent when one of its child tasks completes.
func BuildParentReactivationMessage(childTitle string) string {
	return fmt.Sprintf(
		"Task %q has been completed. Your story has been set back to in_progress. Review the remaining tasks, adjust the plan if needed, then call work_done. Do NOT implement anything yourself. Do NOT call work_done on tasks — each task agent will mark itself done when finished.",
		childTitle,
	)
}
