package rpc

import (
	"encoding/json"
	"maps"
	"reflect"
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
// Every field is populated, story_id included, so that no key is missing merely
// for being omitempty.
func TestWorkListRowCarriesExactlyItsFields(t *testing.T) {
	row, err := json.Marshal(NewWorkListItem(work.Work{
		ID:          "w2",
		StoryID:     "w1",
		AgentRoleID: "role-1",
		Title:       "Some task",
		Body:        "the instructions",
		Status:      work.StatusActive,
		Wait:        work.WaitChild,
		SessionID:   "sess-1",
		Worktree:    "wt",
		CurrentStep: 2,
		CreatedAt:   time.Unix(1, 0),
		UpdatedAt:   time.Unix(2, 0),
	}, work.RowState{Activity: work.ActivityWaitingChildren}))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(row, &fields); err != nil {
		t.Fatalf("unmarshal row: %v", err)
	}

	// id/type/title/activity draw the row; status decides which buttons exist and
	// which group the row is in; wait puts it in "Needs you"; story_id builds
	// the story-task tree and names the story a task belongs to; agent_role_id names
	// the role; session_id is the Chat shortcut; worktree is the badge the global
	// list needs; updated_at orders the closed group.
	want := []string{
		"activity", "agent_role_id", "id", "session_id", "status", "story_id",
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
	// The body is the detail's: a row has nowhere to show free text the agent
	// wrote.
	if strings.Contains(string(row), "the instructions") {
		t.Errorf("list row carries the body: %s", row)
	}
}

// The other side of the same boundary: everything the list stopped carrying has
// to be on the detail, which is now the only place a client can read it.
func TestWorkDetailCarriesTheFieldsTheListDropped(t *testing.T) {
	result, err := json.Marshal(WorkDetailSubscribeResult{Work: NewWorkDetailItem(work.Work{
		ID:          "w1",
		Title:       "Some story",
		Body:        "the instructions",
		CurrentStep: 2,
		CreatedAt:   time.Unix(1, 0),
	})})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, want := range []string{`"body":"the instructions"`, `"current_step":2`, `"created_at"`} {
		if !strings.Contains(string(result), want) {
			t.Errorf("detail result is missing %s: %s", want, result)
		}
	}
}

// `type` is the one field of a row that is derived rather than copied, and the
// client reads it to decide where the row goes: story rows group task rows
// beneath them, and a task row is indented and prints its story's name
// (docs/project-ui.md). Nothing else in the suite looks at the value — the key
// set above only asks that it is present — so a hard-coded or inverted
// derivation here would put every row in the wrong group with every test green.
func TestWorkListRowDerivesItsType(t *testing.T) {
	for _, tc := range []struct {
		name string
		item work.Work
		want work.WorkType
	}{
		{"names no story", work.Work{ID: "s1"}, work.WorkTypeStory},
		{"names a story", work.Work{ID: "t1", StoryID: "s1"}, work.WorkTypeTask},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := NewWorkListItem(tc.item, work.RowState{}).Type; got != tc.want {
				t.Errorf("row type = %q, want %q", got, tc.want)
			}
		})
	}
}

// A detail names a work item's kind twice over: `story_id` is the hierarchy
// itself, and `type` is what the server derives from it, the same key a row
// carries. Both are asserted by *value* and not merely by presence — a
// hard-coded or inverted derivation would put the detail page in the wrong mode
// (Tasks section, page heading, usage column labels) with the key still there.
//
// `story_id` absent rather than empty on a story is the other half: the client's
// field is optional, and the page reads the absence.
func TestWorkDetailSpellsTheHierarchy(t *testing.T) {
	// Asserted against the `work` member's own keys rather than the whole
	// result: the claim is about that object, and a substring search over the
	// result would also answer for any future sibling field spelled the same.
	workKeys := func(t *testing.T, item work.Work) map[string]json.RawMessage {
		t.Helper()
		b, err := json.Marshal(WorkDetailSubscribeResult{Work: NewWorkDetailItem(item)})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var result struct {
			Work map[string]json.RawMessage `json:"work"`
		}
		if err := json.Unmarshal(b, &result); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return result.Work
	}

	task := workKeys(t, work.Work{ID: "t1", StoryID: "s1"})
	if got := string(task["story_id"]); got != `"s1"` {
		t.Errorf("a task's detail names its story as %s, want \"s1\"", got)
	}
	if got := string(task["type"]); got != `"task"` {
		t.Errorf("a work item naming a story has type %s, want \"task\"", got)
	}

	story := workKeys(t, work.Work{ID: "s1"})
	// Absent, not empty: that is what the client's optional field expects, and
	// what the detail page reads to decide whether to draw the Tasks section.
	if _, present := story["story_id"]; present {
		t.Errorf("a story's detail carries a story_id: %s", story["story_id"])
	}
	if got := string(story["type"]); got != `"story"` {
		t.Errorf("a work item naming no story has type %s, want \"story\"", got)
	}
}

// The detail is the stored record plus one derived key, and the field list in
// WorkDetailItem is what keeps that derived key off disk. The cost of listing
// the fields is that one added to work.Work no longer reaches the detail for
// free — it would simply be missing on the page, with nothing failing. So the
// two key sets are compared here, which makes that cost payable by whoever adds
// the field.
//
// Read off the struct tags rather than off marshalled output: an `omitempty`
// field left at its zero value is absent from JSON, and this asks which keys
// exist at all, not which a particular value produces.
func TestWorkDetailItemCarriesEveryStoredField(t *testing.T) {
	stored := jsonKeys(t, reflect.TypeFor[work.Work]())
	// parent_id is the pre-two-level key work.Work reads off old files and never
	// writes; nothing derived from a record should carry it (Work.LegacyParentID).
	delete(stored, "parent_id")
	stored["type"] = struct{}{}

	got := jsonKeys(t, reflect.TypeFor[WorkDetailItem]())
	if !maps.Equal(stored, got) {
		t.Errorf("detail item keys = %v, want the stored record's plus type: %v",
			slices.Sorted(maps.Keys(got)), slices.Sorted(maps.Keys(stored)))
	}
}

// jsonKeys is the keys a struct's exported fields marshal to. An embedded struct
// has no json name of its own, so it fails here rather than being walked into —
// which is what should happen: WorkDetailItem exists because embedding work.Work
// shadows the method that derives `type`.
func jsonKeys(t *testing.T, typ reflect.Type) map[string]struct{} {
	t.Helper()
	keys := make(map[string]struct{}, typ.NumField())
	for i := range typ.NumField() {
		field := typ.Field(i)
		// Unexported fields are not marshalled, so they are not keys.
		if !field.IsExported() {
			continue
		}
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "" || name == "-" {
			t.Fatalf("%s.%s has no json name", typ.Name(), field.Name)
		}
		keys[name] = struct{}{}
	}
	return keys
}
