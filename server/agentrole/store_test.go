package agentrole

import (
	"context"
	"fmt"
	"testing"
)

func newTestStore(t *testing.T) *FileStore {
	t.Helper()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	return store
}

func createRole(t *testing.T, s *FileStore, name, prompt string) AgentRole {
	t.Helper()
	r, err := s.Create(context.Background(), AgentRole{Name: name, RolePrompt: prompt})
	if err != nil {
		t.Fatalf("Create role %q: %v", name, err)
	}
	return r
}

func getRole(t *testing.T, s *FileStore, id string) AgentRole {
	t.Helper()
	r, found, err := s.Get(id)
	if err != nil {
		t.Fatalf("Get %s: %v", id, err)
	}
	if !found {
		t.Fatalf("Get %s: not found", id)
	}
	return r
}

// --- CRUD ---

func TestCreate(t *testing.T) {
	s := newTestStore(t)

	role := createRole(t, s, "Backend Engineer", "You are a backend engineer")

	if role.Name != "Backend Engineer" {
		t.Errorf("name = %q, want %q", role.Name, "Backend Engineer")
	}
	if role.RolePrompt != "You are a backend engineer" {
		t.Errorf("role_prompt = %q, want %q", role.RolePrompt, "You are a backend engineer")
	}
	if role.ID == "" {
		t.Error("expected non-empty ID")
	}
	if role.CreatedAt.IsZero() {
		t.Error("expected non-zero created_at")
	}
}

func TestCreate_EmptyName(t *testing.T) {
	s := newTestStore(t)
	_, err := s.Create(context.Background(), AgentRole{Name: "", RolePrompt: "prompt"})
	if err == nil {
		t.Fatal("expected error for empty name")
	}
}

func TestCreate_EmptyRolePrompt(t *testing.T) {
	s := newTestStore(t)
	role, err := s.Create(context.Background(), AgentRole{Name: "Test", RolePrompt: ""})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if role.RolePrompt != "" {
		t.Errorf("role_prompt = %q, want empty", role.RolePrompt)
	}
}

func TestList(t *testing.T) {
	s := newTestStore(t)

	roles, _ := s.List()
	baseline := len(roles)
	if baseline != len(defaultRoles) {
		t.Fatalf("expected %d default roles, got %d", len(defaultRoles), baseline)
	}

	createRole(t, s, "A", "prompt A")
	createRole(t, s, "B", "prompt B")

	roles, _ = s.List()
	if len(roles) != baseline+2 {
		t.Fatalf("expected %d, got %d", baseline+2, len(roles))
	}
}

func TestGet_NotFound(t *testing.T) {
	s := newTestStore(t)
	_, found, err := s.Get("nonexistent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if found {
		t.Error("expected not found")
	}
}

func TestUpdate_Name(t *testing.T) {
	s := newTestStore(t)
	role := createRole(t, s, "Old", "prompt")

	newName := "New"
	if err := s.Update(context.Background(), role.ID, UpdateFields{Name: &newName}); err != nil {
		t.Fatal(err)
	}

	got := getRole(t, s, role.ID)
	if got.Name != "New" {
		t.Errorf("name = %q, want %q", got.Name, "New")
	}
	if got.UpdatedAt.Equal(role.UpdatedAt) {
		t.Error("expected updated_at to change")
	}
}

func TestUpdate_RolePrompt(t *testing.T) {
	s := newTestStore(t)
	role := createRole(t, s, "Test", "old prompt")

	newPrompt := "new prompt"
	if err := s.Update(context.Background(), role.ID, UpdateFields{RolePrompt: &newPrompt}); err != nil {
		t.Fatal(err)
	}

	got := getRole(t, s, role.ID)
	if got.RolePrompt != "new prompt" {
		t.Errorf("role_prompt = %q, want %q", got.RolePrompt, "new prompt")
	}
}

func TestUpdate_EmptyName(t *testing.T) {
	s := newTestStore(t)
	role := createRole(t, s, "Test", "prompt")

	empty := ""
	err := s.Update(context.Background(), role.ID, UpdateFields{Name: &empty})
	if err == nil {
		t.Fatal("expected error for empty name")
	}
}

func TestUpdate_EmptyRolePrompt(t *testing.T) {
	s := newTestStore(t)
	role := createRole(t, s, "Test", "prompt")

	empty := ""
	err := s.Update(context.Background(), role.ID, UpdateFields{RolePrompt: &empty})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got := getRole(t, s, role.ID)
	if got.RolePrompt != "" {
		t.Errorf("role_prompt = %q, want empty", got.RolePrompt)
	}
}

func TestUpdate_NotFound(t *testing.T) {
	s := newTestStore(t)
	name := "x"
	err := s.Update(context.Background(), "nonexistent", UpdateFields{Name: &name})
	if err == nil {
		t.Fatal("expected error for nonexistent ID")
	}
}

func TestDelete(t *testing.T) {
	s := newTestStore(t)
	role := createRole(t, s, "X", "prompt")

	if err := s.Delete(context.Background(), role.ID); err != nil {
		t.Fatal(err)
	}

	_, found, _ := s.Get(role.ID)
	if found {
		t.Error("expected role to be deleted")
	}
}

func TestDelete_NotFound(t *testing.T) {
	s := newTestStore(t)
	if err := s.Delete(context.Background(), "nonexistent"); err == nil {
		t.Fatal("expected error for nonexistent ID")
	}
}

// --- Persistence ---

func TestPersistence(t *testing.T) {
	dir := t.TempDir()

	s1, _ := NewFileStore(dir)
	role := createRole(t, s1, "Persistent", "persistent prompt")

	s2, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}

	got := getRole(t, s2, role.ID)
	if got.Name != "Persistent" {
		t.Errorf("name = %q, want %q", got.Name, "Persistent")
	}
	if got.RolePrompt != "persistent prompt" {
		t.Errorf("role_prompt = %q, want %q", got.RolePrompt, "persistent prompt")
	}
}

// --- Listener ---

func TestListener_Events(t *testing.T) {
	s := newTestStore(t)

	var events []ChangeEvent
	s.AddOnChangeListener(listenerFunc(func(e ChangeEvent) {
		events = append(events, e)
	}))

	role := createRole(t, s, "S", "prompt")
	if len(events) != 1 || events[0].Op != OperationCreate {
		t.Fatalf("expected 1 create event, got %d events", len(events))
	}

	newName := "Updated"
	s.Update(context.Background(), role.ID, UpdateFields{Name: &newName})
	if len(events) != 2 || events[1].Op != OperationUpdate {
		t.Fatalf("expected update event, got %d events", len(events))
	}

	s.Delete(context.Background(), role.ID)
	if len(events) != 3 || events[2].Op != OperationDelete {
		t.Fatalf("expected delete event, got %d events", len(events))
	}
}

// --- Concurrent operations ---

func TestConcurrent_Creates(t *testing.T) {
	s := newTestStore(t)
	const n = 20

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			_, err := s.Create(context.Background(), AgentRole{
				Name:       fmt.Sprintf("Role %d", i),
				RolePrompt: fmt.Sprintf("Prompt %d", i),
			})
			errs <- err
		}(i)
	}

	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("Create failed: %v", err)
		}
	}

	roles, _ := s.List()
	want := n + len(defaultRoles)
	if len(roles) != want {
		t.Errorf("expected %d roles, got %d", want, len(roles))
	}

	ids := make(map[string]bool)
	for _, r := range roles {
		if ids[r.ID] {
			t.Errorf("duplicate ID: %s", r.ID)
		}
		ids[r.ID] = true
	}
}

func TestConcurrent_UpdateSameRole(t *testing.T) {
	s := newTestStore(t)
	role := createRole(t, s, "Original", "prompt")
	const n = 20

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			name := fmt.Sprintf("Name %d", i)
			errs <- s.Update(context.Background(), role.ID, UpdateFields{Name: &name})
		}(i)
	}

	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("Update failed: %v", err)
		}
	}

	got := getRole(t, s, role.ID)
	if got.Name == "Original" {
		t.Error("name should have been updated")
	}
}

func TestConcurrent_MixedOperations(t *testing.T) {
	s := newTestStore(t)
	role := createRole(t, s, "Base", "prompt")
	const n = 10

	done := make(chan struct{}, n*3)

	for i := 0; i < n; i++ {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			s.Create(context.Background(), AgentRole{
				Name:       fmt.Sprintf("Role %d", i),
				RolePrompt: fmt.Sprintf("Prompt %d", i),
			})
		}(i)
	}

	for i := 0; i < n; i++ {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			name := fmt.Sprintf("Name v%d", i)
			s.Update(context.Background(), role.ID, UpdateFields{Name: &name})
		}(i)
	}

	for i := 0; i < n; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			s.List()
		}()
	}

	for i := 0; i < n*3; i++ {
		<-done
	}

	roles, err := s.List()
	if err != nil {
		t.Fatalf("List after mixed ops: %v", err)
	}
	if len(roles) < 1 {
		t.Error("expected at least 1 role")
	}
}

// --- Default seeding ---

func TestSeed_NewStoreHasDefaults(t *testing.T) {
	s := newTestStore(t)

	roles, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(roles) != len(defaultRoles) {
		t.Fatalf("expected %d default roles, got %d", len(defaultRoles), len(roles))
	}

	names := make(map[string]bool)
	for _, r := range roles {
		names[r.Name] = true
		if r.ID == "" {
			t.Error("seeded role has empty ID")
		}
		if r.RolePrompt == "" {
			t.Errorf("seeded role %q has empty prompt", r.Name)
		}
	}
	for _, d := range defaultRoles {
		if !names[d.Name] {
			t.Errorf("expected default role %q not found", d.Name)
		}
	}
}

func TestSeed_PMRoleID(t *testing.T) {
	s := newTestStore(t)

	pmID := s.SeededPMRoleID()
	if pmID == "" {
		t.Fatal("expected non-empty SeededPMRoleID on fresh store")
	}

	roles, _ := s.List()
	if roles[0].Name != "PM" || roles[0].ID != pmID {
		t.Errorf("SeededPMRoleID = %q, want PM role ID %q", pmID, roles[0].ID)
	}
}

func TestSeed_PMRoleID_EmptyWhenExisting(t *testing.T) {
	dir := t.TempDir()

	s1, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s1.SeededPMRoleID() == "" {
		t.Fatal("expected non-empty SeededPMRoleID on first create")
	}

	s2, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s2.SeededPMRoleID() != "" {
		t.Error("expected empty SeededPMRoleID on reopen")
	}
}

func TestSeed_Persisted(t *testing.T) {
	dir := t.TempDir()

	s1, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	roles1, _ := s1.List()

	s2, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	roles2, _ := s2.List()

	if len(roles2) != len(roles1) {
		t.Fatalf("expected %d roles after reopen, got %d", len(roles1), len(roles2))
	}
	for i, r := range roles2 {
		if r.ID != roles1[i].ID {
			t.Errorf("role %d: ID mismatch: %s vs %s", i, r.ID, roles1[i].ID)
		}
	}
}

func TestSeed_SkippedWhenRolesExist(t *testing.T) {
	dir := t.TempDir()

	s1, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	createRole(t, s1, "Custom", "custom prompt")

	s2, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	roles, _ := s2.List()

	// Should have defaults + 1 custom, not defaults*2 + 1
	if len(roles) != len(defaultRoles)+1 {
		t.Fatalf("expected %d roles, got %d (seeding may have re-run)", len(defaultRoles)+1, len(roles))
	}
}

// --- ResetDefaults ---

func TestResetDefaults(t *testing.T) {
	s := newTestStore(t)

	// Add custom roles
	createRole(t, s, "Custom1", "prompt1")
	createRole(t, s, "Custom2", "prompt2")

	rolesBefore, _ := s.List()
	if len(rolesBefore) != len(defaultRoles)+2 {
		t.Fatalf("expected %d roles before reset, got %d", len(defaultRoles)+2, len(rolesBefore))
	}

	pmRoleID, err := s.ResetDefaults(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	rolesAfter, _ := s.List()
	if len(rolesAfter) != len(defaultRoles) {
		t.Fatalf("expected %d roles after reset, got %d", len(defaultRoles), len(rolesAfter))
	}

	// Verify PM role ID is returned correctly
	if rolesAfter[0].Name != "PM" {
		t.Errorf("first role name = %q, want %q", rolesAfter[0].Name, "PM")
	}
	if pmRoleID != rolesAfter[0].ID {
		t.Errorf("returned PM ID = %q, want %q", pmRoleID, rolesAfter[0].ID)
	}

	// Verify all default role names and prompts are present
	for _, d := range defaultRoles {
		found := false
		for _, r := range rolesAfter {
			if r.Name == d.Name && r.RolePrompt == d.RolePrompt {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("default role %q not found after reset", d.Name)
		}
	}

	// Verify IDs changed (new UUIDs)
	oldIDs := make(map[string]bool)
	for _, r := range rolesBefore {
		oldIDs[r.ID] = true
	}
	for _, r := range rolesAfter {
		if oldIDs[r.ID] {
			t.Errorf("role %q kept old ID %s after reset", r.Name, r.ID)
		}
	}
}

func TestResetDefaults_Listener(t *testing.T) {
	s := newTestStore(t)
	createRole(t, s, "Custom", "prompt")

	var events []ChangeEvent
	s.AddOnChangeListener(listenerFunc(func(e ChangeEvent) {
		events = append(events, e)
	}))

	if _, err := s.ResetDefaults(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Should have delete events for old roles + create events for new defaults
	var deletes, creates int
	for _, e := range events {
		switch e.Op {
		case OperationDelete:
			deletes++
		case OperationCreate:
			creates++
		}
	}
	if deletes != len(defaultRoles)+1 {
		t.Errorf("expected %d delete events, got %d", len(defaultRoles)+1, deletes)
	}
	if creates != len(defaultRoles) {
		t.Errorf("expected %d create events, got %d", len(defaultRoles), creates)
	}
}

func TestResetDefaults_Persisted(t *testing.T) {
	dir := t.TempDir()

	s1, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	createRole(t, s1, "Custom", "prompt")

	if _, err := s1.ResetDefaults(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Reopen and verify
	s2, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	roles, _ := s2.List()
	if len(roles) != len(defaultRoles) {
		t.Fatalf("expected %d roles after reopen, got %d", len(defaultRoles), len(roles))
	}
}

// --- diffRoles ---

func TestDiffRoles_NoChanges(t *testing.T) {
	roles := []AgentRole{
		{ID: "1", Name: "A"},
		{ID: "2", Name: "B"},
	}
	events := diffRoles(roles, roles)
	if len(events) != 0 {
		t.Errorf("expected 0 events, got %d", len(events))
	}
}

func TestDiffRoles_Create(t *testing.T) {
	old := []AgentRole{{ID: "1", Name: "A"}}
	updated := []AgentRole{
		{ID: "1", Name: "A"},
		{ID: "2", Name: "B"},
	}
	events := diffRoles(old, updated)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Op != OperationCreate || events[0].Role.ID != "2" {
		t.Errorf("expected create event for ID 2, got %+v", events[0])
	}
}

func TestDiffRoles_Delete(t *testing.T) {
	old := []AgentRole{
		{ID: "1", Name: "A"},
		{ID: "2", Name: "B"},
	}
	updated := []AgentRole{{ID: "1", Name: "A"}}
	events := diffRoles(old, updated)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Op != OperationDelete || events[0].Role.ID != "2" {
		t.Errorf("expected delete event for ID 2, got %+v", events[0])
	}
}

func TestDiffRoles_Update(t *testing.T) {
	old := []AgentRole{{ID: "1", Name: "A"}}
	updated := []AgentRole{{ID: "1", Name: "A Updated"}}
	events := diffRoles(old, updated)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Op != OperationUpdate || events[0].Role.Name != "A Updated" {
		t.Errorf("expected update event with new name, got %+v", events[0])
	}
}

// --- Test helpers ---

type listenerFunc func(ChangeEvent)

func (f listenerFunc) OnAgentRoleChange(e ChangeEvent) { f(e) }
