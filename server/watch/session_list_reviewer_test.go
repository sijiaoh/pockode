package watch

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/session"
)

func sessionsWithOneReviewer() *mockSessionStore {
	return &mockSessionStore{
		sessions: []session.SessionMeta{
			{ID: "sess-main", Title: "Main"},
			// Only the reviewer is unread, so the badge tells the two lists apart.
			{ID: "sess-reviewer", Title: session.PermissionReviewerTitle, PermissionReviewerOf: "sess-main", Unread: true},
		},
	}
}

func TestSessionListWatcher_Subscribe_ExcludePermissionReviewerSessions(t *testing.T) {
	w := NewSessionListWatcher(sessionsWithOneReviewer(), nil)

	all, err := w.Subscribe("all", nil, SessionListFilter{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if len(all.Sessions) != 2 || !all.HasUnread {
		t.Errorf("unfiltered snapshot = %d rows, unread %v; want both rows and the reviewer's unread", len(all.Sessions), all.HasUnread)
	}
	for _, row := range all.Sessions {
		if row.ID == "sess-reviewer" && row.PermissionReviewerOf != "sess-main" {
			t.Errorf("reviewer row permission_reviewer_of = %q, want sess-main", row.PermissionReviewerOf)
		}
	}

	plain, err := w.Subscribe("plain", nil, SessionListFilter{ExcludePermissionReviewerSessions: true})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if len(plain.Sessions) != 1 || plain.Sessions[0].ID != "sess-main" {
		t.Errorf("filtered snapshot = %+v, want only sess-main", plain.Sessions)
	}
	if plain.HasUnread {
		t.Error("filtered snapshot reports the hidden reviewer as unread")
	}
}

// A reviewer is a reviewer from birth, so a subscriber hiding them is never
// holding one: its changes are not news, not even as a retraction.
func TestSessionListWatcher_ReviewerChange_IsSilentForAFilteringSubscriber(t *testing.T) {
	w := NewSessionListWatcher(sessionsWithOneReviewer(), nil)
	all := &captureNotifier{}
	plain := &captureNotifier{}
	if _, err := w.Subscribe("all", all, SessionListFilter{}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if _, err := w.Subscribe("plain", plain, SessionListFilter{ExcludePermissionReviewerSessions: true}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-reviewer", PermissionReviewerOf: "sess-main"},
	})
	// A change the filtering subscriber does see, sent after: events are
	// handled one at a time in order, so once it arrives the reviewer's change
	// has been dealt with too.
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-main"},
	})

	waitFor(t, func() bool { return all.count() >= 2 && plain.count() >= 1 })

	if plain.count() != 1 {
		t.Fatalf("filtering subscriber got %d notifications, want only sess-main's", plain.count())
	}
	var got sessionListChangedParams
	if err := json.Unmarshal(plain.last(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Session == nil || got.Session.ID != "sess-main" {
		t.Errorf("filtering subscriber got %+v, want sess-main's row", got)
	}
	if got.HasUnread == nil || *got.HasUnread {
		t.Errorf("filtering subscriber has_unread = %v, want false: only the hidden reviewer is unread", got.HasUnread)
	}
}
