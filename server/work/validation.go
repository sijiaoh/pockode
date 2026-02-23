package work

import "fmt"

// validParents defines which parent types are allowed for each work type.
// An empty slice means the type must be top-level (no parent).
var validParents = map[WorkType][]WorkType{
	WorkTypeStory: {},
	WorkTypeTask:  {WorkTypeStory},
}

// validTransitions defines the allowed status transitions.
// done → closed is handled internally by auto-close, not as an external transition.
var validTransitions = map[WorkStatus][]WorkStatus{
	StatusOpen:       {StatusInProgress},
	StatusInProgress: {StatusOpen, StatusNeedsInput, StatusStopped, StatusDone}, // open: rollback on failed start
	StatusNeedsInput: {StatusInProgress, StatusStopped},                         // user confirms → resume; stop button
	StatusStopped:    {StatusInProgress},                                        // restart from stopped
	StatusDone:       {StatusInProgress},                                        // parent re-activation
	StatusClosed:     {StatusInProgress},                                        // parent re-activation after auto-close
}

func ValidateType(t WorkType) bool {
	_, ok := validParents[t]
	return ok
}

func ValidateTransition(from, to WorkStatus) bool {
	for _, allowed := range validTransitions[from] {
		if allowed == to {
			return true
		}
	}
	return false
}

// validNextStatuses returns the statuses that a work item can transition to
// from the given status.
func validNextStatuses(from WorkStatus) []WorkStatus {
	next := validTransitions[from]
	out := make([]WorkStatus, len(next))
	copy(out, next)
	return out
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
