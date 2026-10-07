package agentrole

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/pockode/server/work"
)

func createTypedRole(t *testing.T, s *FileStore, name string, wt work.WorkType) AgentRole {
	t.Helper()
	r, err := s.Create(context.Background(), AgentRole{Name: name, WorkType: wt})
	if err != nil {
		t.Fatalf("Create %s: %v", name, err)
	}
	return r
}

func TestCheckAssignment(t *testing.T) {
	roles := newTestStore(t)
	planner := createTypedRole(t, roles, "Planner", work.WorkTypeStory)
	engineer := createTypedRole(t, roles, "Engineer", work.WorkTypeTask)
	anyone := createTypedRole(t, roles, "Anyone", "")

	for _, tc := range []struct {
		name   string
		roleID string
		t      work.WorkType
		ok     bool
	}{
		{"matching type", planner.ID, work.WorkTypeStory, true},
		{"unrestricted role, story", anyone.ID, work.WorkTypeStory, true},
		{"unrestricted role, task", anyone.ID, work.WorkTypeTask, true},
		{"story role on a task", planner.ID, work.WorkTypeTask, false},
		{"task role on a story", engineer.ID, work.WorkTypeStory, false},
		{"unknown role", "nope", work.WorkTypeStory, false},
		{"no role", "", work.WorkTypeStory, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := CheckAssignment(roles, tc.roleID, tc.t)
			if tc.ok {
				if err != nil {
					t.Fatalf("refused: %v", err)
				}
				return
			}
			// Every refusal is the caller's mistake, which is how both
			// transports know to report it as one.
			if !errors.Is(err, work.ErrInvalidWork) {
				t.Fatalf("err = %v, want one wrapping ErrInvalidWork", err)
			}
		})
	}
}

// The refusal is all an agent has to correct its call with, so it names every
// role that would have been accepted — unrestricted ones included — and none
// that would not.
func TestCheckAssignment_RefusalNamesTheRolesThatFit(t *testing.T) {
	roles := newTestStore(t)
	planner := createTypedRole(t, roles, "Planner", work.WorkTypeStory)
	engineer := createTypedRole(t, roles, "Engineer", work.WorkTypeTask)
	anyone := createTypedRole(t, roles, "Anyone", "")

	msg := CheckAssignment(roles, planner.ID, work.WorkTypeTask).Error()
	for _, want := range []string{planner.ID, engineer.ID, `"Engineer"`, anyone.ID, `"Anyone"`} {
		if !strings.Contains(msg, want) {
			t.Errorf("refusal %q does not mention %s", msg, want)
		}
	}
	if strings.Count(msg, planner.ID) != 1 {
		t.Errorf("refusal %q offers the refused role as an alternative", msg)
	}
}

func TestCheckAssignment_RefusalSaysWhenNoRoleFits(t *testing.T) {
	roles := newTestStore(t)
	seeded, err := roles.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range seeded {
		if err := roles.Delete(context.Background(), r.ID); err != nil {
			t.Fatal(err)
		}
	}
	planner := createTypedRole(t, roles, "Planner", work.WorkTypeStory)

	err = CheckAssignment(roles, planner.ID, work.WorkTypeTask)
	if err == nil || !strings.Contains(err.Error(), "none") {
		t.Fatalf("err = %v, want a refusal saying no role takes task work", err)
	}
}

func TestCheckReassignment(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	roles, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	works, err := work.NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	planner := createTypedRole(t, roles, "Planner", work.WorkTypeStory)
	engineer := createTypedRole(t, roles, "Engineer", work.WorkTypeTask)
	story, err := works.Create(ctx, work.Work{Title: "S", AgentRoleID: planner.ID})
	if err != nil {
		t.Fatal(err)
	}

	ptr := func(s string) *string { return &s }

	if err := CheckReassignment(roles, works, story.ID, nil); err != nil {
		t.Errorf("update without a role: %v", err)
	}
	if err := CheckReassignment(roles, works, story.ID, ptr(engineer.ID)); !errors.Is(err, work.ErrInvalidWork) {
		t.Errorf("assigning a task role to a story: err = %v, want a refusal", err)
	}
	if err := CheckReassignment(roles, works, "nope", ptr(planner.ID)); !errors.Is(err, work.ErrWorkNotFound) {
		t.Errorf("unknown work: err = %v, want ErrWorkNotFound", err)
	}

	// The restriction is checked on assignment only: a role restricted away
	// after the fact must not lock up the work it is already on, including an
	// update that merely repeats the role it has.
	taskOnly := work.WorkTypeTask
	if err := roles.Update(ctx, planner.ID, UpdateFields{WorkType: &taskOnly}); err != nil {
		t.Fatal(err)
	}
	if err := CheckReassignment(roles, works, story.ID, nil); err != nil {
		t.Errorf("update leaving the role alone: %v", err)
	}
	if err := CheckReassignment(roles, works, story.ID, ptr(planner.ID)); err != nil {
		t.Errorf("update repeating the current role: %v", err)
	}
}
