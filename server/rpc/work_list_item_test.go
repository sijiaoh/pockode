package rpc

import (
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/work"
)

// The work list goes out for every work item in the app, and again on every
// change to any of them, so what a row carries is asserted as an exact set
// rather than as a list of forbidden names: anything later added to work.Work —
// a usage aggregation above all — reaches the list only by being added here too,
// and this fails when it is.
//
// Every field is populated, parent_id included, so that no key is missing merely
// for being omitempty.
func TestWorkListRowCarriesExactlyItsFields(t *testing.T) {
	row, err := json.Marshal(NewWorkListItem(work.Work{
		ID:          "w2",
		Type:        work.WorkTypeTask,
		ParentID:    "w1",
		AgentRoleID: "role-1",
		Title:       "Some task",
		Body:        "the instructions",
		Status:      work.StatusActive,
		Wait:        work.WaitUser,
		WaitReason:  "which database?",
		SessionID:   "sess-1",
		Worktree:    "wt",
		CurrentStep: 2,
		CreatedAt:   time.Unix(1, 0),
		UpdatedAt:   time.Unix(2, 0),
	}, work.ActivityNeedsMessage))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(row, &fields); err != nil {
		t.Fatalf("unmarshal row: %v", err)
	}

	// id/type/title/activity draw the row; status decides which buttons exist and
	// which group the row is in; wait puts it in "Needs you"; parent_id builds
	// the story-task tree and walks a work up to its root; agent_role_id names
	// the role; session_id is the Chat shortcut and the session list's work
	// lookup; worktree is the badge the global list needs; updated_at orders the
	// closed group.
	want := []string{
		"activity", "agent_role_id", "id", "parent_id", "session_id", "status",
		"title", "type", "updated_at", "wait", "worktree",
	}
	if got := slices.Sorted(maps.Keys(fields)); !slices.Equal(got, want) {
		t.Errorf("row fields = %v, want %v", got, want)
	}

	// Named separately from the set comparison above: a body leaking into the list
	// is the failure this split exists to prevent, and a key named something other
	// than "body" carrying it would still be that failure.
	if strings.Contains(string(row), "the instructions") {
		t.Errorf("list row carries the work body: %s", row)
	}
	// The wait's reason is the detail's, for the same reason the body is: a row
	// has nowhere to show free text the agent wrote.
	if strings.Contains(string(row), "which database?") {
		t.Errorf("list row carries the wait reason: %s", row)
	}
}

// The other side of the same boundary: everything the list stopped carrying has
// to be on the detail, which is now the only place a client can read it.
func TestWorkDetailCarriesTheFieldsTheListDropped(t *testing.T) {
	result, err := json.Marshal(WorkDetailSubscribeResult{Work: work.Work{
		ID:          "w1",
		Title:       "Some story",
		Body:        "the instructions",
		CurrentStep: 2,
		WaitReason:  "which database?",
		CreatedAt:   time.Unix(1, 0),
	}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, want := range []string{`"body":"the instructions"`, `"current_step":2`, `"created_at"`, `"wait_reason":"which database?"`} {
		if !strings.Contains(string(result), want) {
			t.Errorf("detail result is missing %s: %s", want, result)
		}
	}
}
