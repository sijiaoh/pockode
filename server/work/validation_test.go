package work

import (
	"context"
	"testing"
)

func TestValidateSessionIDChange_CannotSetOnDone(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	// Setting SessionID with in_progress → done should fail
	sid := "new-session"
	doneStatus := StatusDone
	err := s.Update(context.Background(), story.ID, UpdateFields{
		SessionID: &sid,
		Status:    &doneStatus,
	})
	if err == nil {
		t.Fatal("expected error when setting session_id on done transition")
	}
}

func TestValidateSessionIDChange_CannotClearOnDone(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, story.ID, "session-1")
	startWork(t, s, task.ID)

	// Clearing SessionID with in_progress → done should fail
	emptySid := ""
	doneStatus := StatusDone
	err := s.Update(context.Background(), story.ID, UpdateFields{
		SessionID: &emptySid,
		Status:    &doneStatus,
	})
	if err == nil {
		t.Fatal("expected error when clearing session_id on done transition")
	}
}

// --- ValidNextStatuses ---

func TestValidNextStatuses(t *testing.T) {
	tests := []struct {
		from     WorkStatus
		expected []WorkStatus
	}{
		{StatusOpen, []WorkStatus{StatusInProgress}},
		{StatusInProgress, []WorkStatus{StatusOpen, StatusDone}},
		{StatusDone, []WorkStatus{StatusInProgress}},
		{StatusClosed, nil},
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
