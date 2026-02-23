package work

import "testing"

// --- ValidNextStatuses ---

func TestValidNextStatuses(t *testing.T) {
	tests := []struct {
		from     WorkStatus
		expected []WorkStatus
	}{
		{StatusOpen, []WorkStatus{StatusInProgress}},
		{StatusInProgress, []WorkStatus{StatusOpen, StatusNeedsInput, StatusStopped, StatusDone}},
		{StatusNeedsInput, []WorkStatus{StatusInProgress, StatusStopped}},
		{StatusStopped, []WorkStatus{StatusInProgress}},
		{StatusDone, []WorkStatus{StatusInProgress}},
		{StatusClosed, []WorkStatus{StatusInProgress}},
	}

	for _, tt := range tests {
		next := ValidNextStatuses(tt.from)
		if len(next) != len(tt.expected) {
			t.Errorf("ValidNextStatuses(%s) = %v, want %v", tt.from, next, tt.expected)
			continue
		}
		for i, s := range next {
			if s != tt.expected[i] {
				t.Errorf("ValidNextStatuses(%s)[%d] = %s, want %s", tt.from, i, s, tt.expected[i])
			}
		}
	}
}
