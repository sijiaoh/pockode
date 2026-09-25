package work

import "fmt"

var (
	errWorkNotStarted = fmt.Errorf("%w: work has not been started; start it first", ErrInvalidWork)
	errWorkClosed     = fmt.Errorf("%w: work is closed; reopen it to continue", ErrInvalidWork)
	errWorkRunning    = fmt.Errorf("%w: work is already running", ErrInvalidWork)
)

// A work's status answers two independent questions, and the two guards below
// are split along that line.
//
// "Might an agent session be running?" — active and stopped both say yes; they
// differ in whether the engine is driving it. Neither says how far the work got
// — that is CurrentStep — and neither is evidence about the session itself,
// which can die without the work leaving active. So they must never gate
// progress: an agent able to call step_done is running whatever its status
// claims. Gating on them is how a work that had merely gone stopped became
// impossible to advance or finish.
//
// "Is the work outside the agent lifecycle?" — open (no session was ever
// created) and closed (deliberately finished) say yes, and each has its own way
// back in, Start and Reopen respectively. These two are the only real gates.
//
// Both guards therefore name the statuses they reject and admit anything else.
// That is deliberate: a status nobody recognises — a hand-edited or corrupted
// index — must not be one more way to lock a work item out of its own agent.

// ValidateProgress checks that a work item can be moved along by its agent:
// step_done, story_wait, stopping, or a liveness sync.
func ValidateProgress(status WorkStatus) error {
	switch status {
	case StatusOpen:
		return errWorkNotStarted
	case StatusClosed:
		return errWorkClosed
	}
	return nil
}

// ValidateStartable checks that an agent session can be started for a work
// item. Unlike ValidateProgress it admits open — that is the fresh-start case —
// and rejects active, so a running work is never started a second time.
// That rejection is also what resolves concurrent Claims to a single winner.
func ValidateStartable(status WorkStatus) error {
	switch status {
	case StatusActive:
		return errWorkRunning
	case StatusClosed:
		return errWorkClosed
	}
	return nil
}

// ValidateStory checks the work a new task names as its story. There is no
// table of allowed parents any more, and no rule about the child either: the
// field is called StoryID, so the only thing left to check is that it holds a
// story. A task naming a task is how a third level would be built, and this is
// where it is refused.
func ValidateStory(story Work) error {
	if story.Type() != WorkTypeStory {
		return fmt.Errorf("%w: %s is a task and cannot hold tasks of its own; name its story %s instead", ErrInvalidWork, story.ID, story.StoryID)
	}
	return nil
}
