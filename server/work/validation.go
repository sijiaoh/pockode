package work

import "fmt"

// validParents defines which parent types are allowed for each work type.
// An empty slice means the type must be top-level (no parent).
var validParents = map[WorkType][]WorkType{
	WorkTypeStory: {},
	WorkTypeTask:  {WorkTypeStory},
}

var (
	errWorkNotStarted = fmt.Errorf("%w: work has not been started; start it first", ErrInvalidWork)
	errWorkClosed     = fmt.Errorf("%w: work is closed; reopen it to continue", ErrInvalidWork)
	errWorkRunning    = fmt.Errorf("%w: work is already running", ErrInvalidWork)
)

// A work's status answers two independent questions, and the two guards below
// are split along that line.
//
// "Might an agent session be running?" — in_progress, needs_input, waiting and
// stopped all say yes; they differ only in what the session is doing. All four
// are derived from process events and go stale (a crashed CLI, an orphaned
// session, a dropped event), and none of them says how far the work got — that
// is CurrentStep. So they must never gate progress: an agent able to call
// step_done is running whatever its status claims. Gating on them is how a work
// that had merely gone stopped became impossible to advance or finish.
//
// "Is the work outside the agent lifecycle?" — open (no session was ever
// created) and closed (deliberately finished) say yes, and each has its own way
// back in, Start and Reopen respectively. These two are the only real gates.
//
// Both guards therefore name the statuses they reject and admit anything else.
// That is deliberate: a status nobody recognises — a hand-edited or corrupted
// index — must not be one more way to lock a work item out of its own agent.

// ValidateProgress checks that a work item can be moved along by its agent:
// step_done, work_wait, work_needs_input, stopping, or a liveness sync.
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
// and rejects in_progress, so a running work is never started a second time.
// That rejection is also what resolves concurrent Claims to a single winner.
func ValidateStartable(status WorkStatus) error {
	switch status {
	case StatusInProgress:
		return errWorkRunning
	case StatusClosed:
		return errWorkClosed
	}
	return nil
}

func ValidateType(t WorkType) bool {
	_, ok := validParents[t]
	return ok
}

// ValidateParent checks that the parent is a valid type for the given child type.
// parent == nil means no parent (top-level).
func ValidateParent(childType WorkType, parent *Work) error {
	allowed := validParents[childType]

	if len(allowed) == 0 {
		// Must be top-level
		if parent != nil {
			return fmt.Errorf("%w: %s must be top-level, got parent %s", ErrInvalidWork, childType, parent.Type)
		}
		return nil
	}

	// Must have a parent
	if parent == nil {
		return fmt.Errorf("%w: %s requires a parent of type %v", ErrInvalidWork, childType, allowed)
	}

	for _, t := range allowed {
		if parent.Type == t {
			return nil
		}
	}
	return fmt.Errorf("%w: %s cannot be a child of %s", ErrInvalidWork, childType, parent.Type)
}
