package node

import (
	"fmt"
	"os"
	"path/filepath"
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

func createTestDir(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("create test dir: %v", err)
	}
	return dir
}

func createNode(t *testing.T, s *FileStore, path, name string) Node {
	t.Helper()
	n, err := s.Create(path, name)
	if err != nil {
		t.Fatalf("Create node: %v", err)
	}
	return n
}

func getNode(t *testing.T, s *FileStore, id string) Node {
	t.Helper()
	n, found, err := s.Get(id)
	if err != nil {
		t.Fatalf("Get %s: %v", id, err)
	}
	if !found {
		t.Fatalf("Get %s: not found", id)
	}
	return n
}

// --- CRUD ---

func TestCreate(t *testing.T) {
	s := newTestStore(t)
	dir := createTestDir(t, "project")

	node := createNode(t, s, dir, "My Project")

	if node.Name != "My Project" {
		t.Errorf("name = %q, want %q", node.Name, "My Project")
	}
	if node.Path != dir {
		t.Errorf("path = %q, want %q", node.Path, dir)
	}
	if node.ID == "" {
		t.Error("expected non-empty ID")
	}
	if node.CreatedAt.IsZero() {
		t.Error("expected non-zero created_at")
	}
}

func TestCreate_InferName(t *testing.T) {
	s := newTestStore(t)
	dir := createTestDir(t, "my-project")

	node := createNode(t, s, dir, "")

	if node.Name != "my-project" {
		t.Errorf("name = %q, want %q (inferred from path)", node.Name, "my-project")
	}
}

func TestCreate_EmptyPath(t *testing.T) {
	s := newTestStore(t)
	_, err := s.Create("", "name")
	if err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestCreate_PathNotExist(t *testing.T) {
	s := newTestStore(t)
	_, err := s.Create("/nonexistent/path/12345", "name")
	if err == nil {
		t.Fatal("expected error for nonexistent path")
	}
}

func TestCreate_PathIsFile(t *testing.T) {
	s := newTestStore(t)
	file := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(file, []byte("test"), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := s.Create(file, "name")
	if err == nil {
		t.Fatal("expected error for file path")
	}
}

func TestCreate_DuplicatePath(t *testing.T) {
	s := newTestStore(t)
	dir := createTestDir(t, "project")

	createNode(t, s, dir, "First")

	_, err := s.Create(dir, "Second")
	if err == nil {
		t.Fatal("expected error for duplicate path")
	}
}

func TestList(t *testing.T) {
	s := newTestStore(t)

	nodes, _ := s.List()
	if len(nodes) != 0 {
		t.Fatalf("expected 0 nodes initially, got %d", len(nodes))
	}

	dir1 := createTestDir(t, "project1")
	dir2 := createTestDir(t, "project2")
	createNode(t, s, dir1, "A")
	createNode(t, s, dir2, "B")

	nodes, _ = s.List()
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
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
	dir := createTestDir(t, "project")
	node := createNode(t, s, dir, "Old")

	newName := "New"
	updated, err := s.Update(node.ID, UpdateFields{Name: &newName})
	if err != nil {
		t.Fatal(err)
	}

	if updated.Name != "New" {
		t.Errorf("name = %q, want %q", updated.Name, "New")
	}
	if updated.UpdatedAt.Equal(node.UpdatedAt) {
		t.Error("expected updated_at to change")
	}
}

func TestUpdate_Path(t *testing.T) {
	s := newTestStore(t)
	dir1 := createTestDir(t, "project1")
	dir2 := createTestDir(t, "project2")
	node := createNode(t, s, dir1, "Test")

	updated, err := s.Update(node.ID, UpdateFields{Path: &dir2})
	if err != nil {
		t.Fatal(err)
	}

	if updated.Path != dir2 {
		t.Errorf("path = %q, want %q", updated.Path, dir2)
	}
}

func TestUpdate_NoChange(t *testing.T) {
	s := newTestStore(t)
	dir := createTestDir(t, "project")
	node := createNode(t, s, dir, "Test")

	// Update with same values
	sameName := "Test"
	updated, err := s.Update(node.ID, UpdateFields{Name: &sameName})
	if err != nil {
		t.Fatal(err)
	}

	// UpdatedAt should not change when there's no actual change
	if !updated.UpdatedAt.Equal(node.UpdatedAt) {
		t.Error("expected updated_at to remain unchanged when no actual change")
	}
}

func TestUpdate_DuplicatePath(t *testing.T) {
	s := newTestStore(t)
	dir1 := createTestDir(t, "project1")
	dir2 := createTestDir(t, "project2")
	createNode(t, s, dir1, "First")
	node2 := createNode(t, s, dir2, "Second")

	// Try to update node2's path to dir1 (already used)
	_, err := s.Update(node2.ID, UpdateFields{Path: &dir1})
	if err == nil {
		t.Fatal("expected error for duplicate path")
	}
}

func TestUpdate_NotFound(t *testing.T) {
	s := newTestStore(t)
	name := "x"
	_, err := s.Update("nonexistent", UpdateFields{Name: &name})
	if err == nil {
		t.Fatal("expected error for nonexistent ID")
	}
}

func TestDelete(t *testing.T) {
	s := newTestStore(t)
	dir := createTestDir(t, "project")
	node := createNode(t, s, dir, "Test")

	if err := s.Delete(node.ID); err != nil {
		t.Fatal(err)
	}

	_, found, _ := s.Get(node.ID)
	if found {
		t.Error("expected node to be deleted")
	}
}

func TestDelete_NotFound(t *testing.T) {
	s := newTestStore(t)
	if err := s.Delete("nonexistent"); err == nil {
		t.Fatal("expected error for nonexistent ID")
	}
}

// --- Persistence ---

func TestPersistence(t *testing.T) {
	dataDir := t.TempDir()
	projectDir := createTestDir(t, "project")

	s1, _ := NewFileStore(dataDir)
	node := createNode(t, s1, projectDir, "Persistent")

	s2, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}

	got := getNode(t, s2, node.ID)
	if got.Name != "Persistent" {
		t.Errorf("name = %q, want %q", got.Name, "Persistent")
	}
	if got.Path != projectDir {
		t.Errorf("path = %q, want %q", got.Path, projectDir)
	}
}

// --- Concurrent operations ---

func TestConcurrent_Creates(t *testing.T) {
	s := newTestStore(t)
	const n = 20

	dirs := make([]string, n)
	for i := 0; i < n; i++ {
		dirs[i] = createTestDir(t, fmt.Sprintf("project%d", i))
	}

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			_, err := s.Create(dirs[i], fmt.Sprintf("Node %d", i))
			errs <- err
		}(i)
	}

	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("Create failed: %v", err)
		}
	}

	nodes, _ := s.List()
	if len(nodes) != n {
		t.Errorf("expected %d nodes, got %d", n, len(nodes))
	}

	ids := make(map[string]bool)
	for _, n := range nodes {
		if ids[n.ID] {
			t.Errorf("duplicate ID: %s", n.ID)
		}
		ids[n.ID] = true
	}
}

func TestConcurrent_UpdateSameNode(t *testing.T) {
	s := newTestStore(t)
	dir := createTestDir(t, "project")
	node := createNode(t, s, dir, "Original")
	const n = 20

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			name := fmt.Sprintf("Name %d", i)
			_, err := s.Update(node.ID, UpdateFields{Name: &name})
			errs <- err
		}(i)
	}

	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("Update failed: %v", err)
		}
	}

	got := getNode(t, s, node.ID)
	if got.Name == "Original" {
		t.Error("name should have been updated")
	}
}

func TestConcurrent_MixedOperations(t *testing.T) {
	s := newTestStore(t)
	baseDir := createTestDir(t, "base")
	node := createNode(t, s, baseDir, "Base")
	const n = 10

	done := make(chan struct{}, n*3)

	for i := 0; i < n; i++ {
		dir := createTestDir(t, fmt.Sprintf("project%d", i))
		go func(i int, dir string) {
			defer func() { done <- struct{}{} }()
			s.Create(dir, fmt.Sprintf("Node %d", i))
		}(i, dir)
	}

	for i := 0; i < n; i++ {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			name := fmt.Sprintf("Name v%d", i)
			s.Update(node.ID, UpdateFields{Name: &name})
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

	nodes, err := s.List()
	if err != nil {
		t.Fatalf("List after mixed ops: %v", err)
	}
	if len(nodes) < 1 {
		t.Error("expected at least 1 node")
	}
}
