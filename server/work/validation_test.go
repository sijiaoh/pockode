package work

import "testing"

// --- status guards ---

func TestValidateProgress(t *testing.T) {
	tests := []struct {
		status  WorkStatus
		allowed bool
	}{
		{StatusOpen, false},
		{StatusActive, true},
		{StatusStopped, true},
		{StatusClosed, false},
		// A value nobody recognises is admitted on purpose: a corrupted index
		// must not be one more way to lock a work out of its own agent.
		{WorkStatus("in_progress"), true},
	}

	for _, tt := range tests {
		err := ValidateProgress(tt.status)
		if tt.allowed && err != nil {
			t.Errorf("ValidateProgress(%s) = %v, want nil", tt.status, err)
		}
		if !tt.allowed && err == nil {
			t.Errorf("ValidateProgress(%s) = nil, want error", tt.status)
		}
	}
}

func TestValidateStartable(t *testing.T) {
	tests := []struct {
		status  WorkStatus
		allowed bool
	}{
		{StatusOpen, true},
		{StatusActive, false}, // already running; must not start twice
		{StatusStopped, true},
		{StatusClosed, false},
	}

	for _, tt := range tests {
		err := ValidateStartable(tt.status)
		if tt.allowed && err != nil {
			t.Errorf("ValidateStartable(%s) = %v, want nil", tt.status, err)
		}
		if !tt.allowed && err == nil {
			t.Errorf("ValidateStartable(%s) = nil, want error", tt.status)
		}
	}
}
