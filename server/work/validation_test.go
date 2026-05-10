package work

import "testing"

// --- validNextStatuses ---

func Test_validNextStatuses(t *testing.T) {
	tests := []struct {
		from     WorkStatus
		expected []WorkStatus
	}{
		{StatusOpen, []WorkStatus{StatusInProgress}},
		{StatusInProgress, []WorkStatus{StatusOpen, StatusNeedsInput, StatusWaiting, StatusStopped, StatusClosed}},
		{StatusNeedsInput, []WorkStatus{StatusInProgress, StatusStopped}},
		{StatusWaiting, []WorkStatus{StatusInProgress, StatusStopped}},
		{StatusStopped, []WorkStatus{StatusInProgress}},
		{StatusClosed, []WorkStatus{}},
	}

	for _, tt := range tests {
		next := validNextStatuses(tt.from)
		if len(next) != len(tt.expected) {
			t.Errorf("validNextStatuses(%s) = %v, want %v", tt.from, next, tt.expected)
			continue
		}
		for i, s := range next {
			if s != tt.expected[i] {
				t.Errorf("validNextStatuses(%s)[%d] = %s, want %s", tt.from, i, s, tt.expected[i])
			}
		}
	}
}
