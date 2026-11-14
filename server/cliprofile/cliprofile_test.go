package cliprofile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pockode/server/internal/fspermtest"
	"github.com/pockode/server/session"
)

const (
	claude = session.AgentTypeClaude
	codex  = session.AgentTypeCodex
)

func mustAdd(t *testing.T, s *Store, agent session.AgentType, name string) Profile {
	t.Helper()
	p, err := s.Add(agent, name)
	if err != nil {
		t.Fatalf("Add(%s, %q): %v", agent, name, err)
	}
	return p
}

func mustLoad(t *testing.T, s *Store, agent session.AgentType) List {
	t.Helper()
	l, err := s.Load(agent)
	if err != nil {
		t.Fatalf("Load(%s): %v", agent, err)
	}
	return l
}

func names(l List) []string {
	var out []string
	for _, p := range l.Profiles {
		out = append(out, p.Name)
	}
	return out
}

// With nothing stored, every CLI is on its default profile, and looking does
// not create the directory.
func TestLoadWithoutFile(t *testing.T) {
	configDir := t.TempDir()
	s := NewStore(configDir)
	for _, agent := range []session.AgentType{claude, codex} {
		l := mustLoad(t, s, agent)
		if l.Current != "" || l.Profiles == nil || len(l.Profiles) != 0 {
			t.Errorf("Load(%s) = %+v, want empty list on the default profile", agent, l)
		}
		if p, err := s.Current(agent); err != nil || p != nil {
			t.Errorf("Current(%s) = %+v, %v; want the default profile", agent, p, err)
		}
	}
	if _, err := os.Stat(filepath.Join(configDir, "pockode")); !os.IsNotExist(err) {
		t.Errorf("Load created the directory (stat error %v)", err)
	}
}

// Profiles are kept per CLI, in the order they were added, and survive a new
// store over the same directory — another process reads what this one wrote.
func TestAddKeepsProfilesPerCLI(t *testing.T) {
	configDir := t.TempDir()
	s := NewStore(configDir)
	work := mustAdd(t, s, claude, "  Work  ")
	mustAdd(t, s, claude, "Personal")
	mustAdd(t, s, codex, "Work")

	if work.Name != "Work" {
		t.Errorf("name = %q, want it trimmed to %q", work.Name, "Work")
	}
	if !validID(work.ID) {
		t.Errorf("ID %q is not one Dir accepts", work.ID)
	}

	other := NewStore(configDir)
	if got := names(mustLoad(t, other, claude)); strings.Join(got, ",") != "Work,Personal" {
		t.Errorf("claude profiles = %v", got)
	}
	if got := names(mustLoad(t, other, codex)); strings.Join(got, ",") != "Work" {
		t.Errorf("codex profiles = %v", got)
	}
	if l := mustLoad(t, other, claude); l.Current != "" {
		t.Errorf("Add made %q current", l.Current)
	}
}

func TestSetCurrent(t *testing.T) {
	s := NewStore(t.TempDir())
	p := mustAdd(t, s, claude, "Work")

	if err := s.SetCurrent(claude, p.ID); err != nil {
		t.Fatalf("SetCurrent: %v", err)
	}
	if got, err := s.Current(claude); err != nil || got == nil || *got != p {
		t.Errorf("Current = %+v, %v; want %+v", got, err, p)
	}
	if got, _ := s.Current(codex); got != nil {
		t.Errorf("codex Current = %+v, want the default profile", got)
	}

	if err := s.SetCurrent(codex, p.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetCurrent to another CLI's profile: %v, want ErrNotFound", err)
	}

	if err := s.SetCurrent(claude, ""); err != nil {
		t.Fatalf("SetCurrent(default): %v", err)
	}
	if got, _ := s.Current(claude); got != nil {
		t.Errorf("Current = %+v after switching back, want the default profile", got)
	}
}

func TestRename(t *testing.T) {
	s := NewStore(t.TempDir())
	work := mustAdd(t, s, claude, "Work")
	personal := mustAdd(t, s, claude, "Personal")

	if err := s.Rename(claude, work.ID, "Team"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := s.Rename(claude, work.ID, "team"); err != nil {
		t.Errorf("Rename to its own name in another case: %v", err)
	}
	if err := s.Rename(claude, personal.ID, "TEAM"); !errors.Is(err, ErrNameTaken) {
		t.Errorf("Rename onto another profile's name: %v, want ErrNameTaken", err)
	}
	if err := s.Rename(claude, "019f0000-0000-7000-8000-000000000000", "X"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Rename of an unknown profile: %v, want ErrNotFound", err)
	}
	if got := names(mustLoad(t, s, claude)); strings.Join(got, ",") != "team,Personal" {
		t.Errorf("profiles = %v", got)
	}
}

func TestNameValidation(t *testing.T) {
	s := NewStore(t.TempDir())
	mustAdd(t, s, claude, "Work")
	for _, tt := range []struct {
		name string
		want error
	}{
		{"", ErrInvalidName},
		{"   ", ErrInvalidName},
		{"a\nb", ErrInvalidName},
		{strings.Repeat("あ", MaxNameLength+1), ErrInvalidName},
		{strings.Repeat("あ", MaxNameLength), nil},
		{"work", ErrNameTaken},
	} {
		if _, err := s.Add(claude, tt.name); !errors.Is(err, tt.want) {
			t.Errorf("Add(%q) = %v, want %v", tt.name, err, tt.want)
		}
	}
	if _, err := s.Add(codex, "Work"); err != nil {
		t.Errorf("a name is only taken within one CLI: %v", err)
	}
}

// Removing the current profile falls back to the default one, and takes the
// profile's directory with it — but never what its links point at.
func TestRemove(t *testing.T) {
	configDir := t.TempDir()
	s := NewStore(configDir)
	work := mustAdd(t, s, claude, "Work")
	keep := mustAdd(t, s, claude, "Personal")
	if err := s.SetCurrent(claude, work.ID); err != nil {
		t.Fatal(err)
	}

	dir, err := s.Dir(claude, work.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	shared := filepath.Join(t.TempDir(), "projects")
	if err := os.Mkdir(shared, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shared, "conversation.jsonl"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	linked := os.Symlink(shared, filepath.Join(dir, "projects")) == nil

	if err := s.Remove(claude, work.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	l := mustLoad(t, s, claude)
	if l.Current != "" || len(l.Profiles) != 1 || l.Profiles[0] != keep {
		t.Errorf("after Remove: %+v, want only %+v on the default profile", l, keep)
	}
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		t.Errorf("profile directory still there (lstat error %v)", err)
	}
	if linked {
		if _, err := os.Stat(filepath.Join(shared, "conversation.jsonl")); err != nil {
			t.Errorf("Remove reached through a link: %v", err)
		}
	}

	if err := s.Remove(claude, work.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second Remove: %v, want ErrNotFound", err)
	}
}

// Removing the last profile leaves no trace of the CLI in the file.
func TestRemoveLastProfileDropsTheCLI(t *testing.T) {
	s := NewStore(t.TempDir())
	p := mustAdd(t, s, codex, "Work")
	if err := s.Remove(codex, p.ID); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "codex") {
		t.Errorf("file still names codex: %s", data)
	}
}

// An ID ends up in a path, and may come from a client.
func TestDirRejectsWhatItCouldNotHaveIssued(t *testing.T) {
	s := NewStore(t.TempDir())
	p := mustAdd(t, s, claude, "Work")
	dir, err := s.Dir(claude, p.ID)
	if err != nil {
		t.Fatalf("Dir: %v", err)
	}
	if filepath.Base(dir) != p.ID || filepath.Base(filepath.Dir(dir)) != string(claude) {
		t.Errorf("Dir = %q, want .../claude/%s", dir, p.ID)
	}

	for _, id := range []string{"", "..", "../../etc", "work", strings.ToUpper(p.ID), "{" + p.ID + "}"} {
		if _, err := s.Dir(claude, id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Dir(%q) = %v, want ErrNotFound", id, err)
		}
	}
	if _, err := s.Dir("gemini", p.ID); !errors.Is(err, ErrUnsupportedAgent) {
		t.Errorf("Dir for an unknown CLI: %v, want ErrUnsupportedAgent", err)
	}
}

func TestUnsupportedAgent(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := s.Add("gemini", "Work"); !errors.Is(err, ErrUnsupportedAgent) {
		t.Errorf("Add: %v, want ErrUnsupportedAgent", err)
	}
	if _, err := s.Load("gemini"); !errors.Is(err, ErrUnsupportedAgent) {
		t.Errorf("Load: %v, want ErrUnsupportedAgent", err)
	}
}

// The directory holds every profile's credentials.
func TestChangeRestrictsDirectory(t *testing.T) {
	configDir := t.TempDir()
	mustAdd(t, NewStore(configDir), claude, "Work")
	fspermtest.RequireOwnerOnly(t, filepath.Join(configDir, "pockode"))
}

// A damaged file is quarantined, not overwritten, and a change goes on over
// the empty list instead of failing until someone looks.
func TestChangeOverDamagedFile(t *testing.T) {
	s := NewStore(t.TempDir())
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.path, []byte(`{"claude":`), 0600); err != nil {
		t.Fatal(err)
	}

	mustAdd(t, s, claude, "Work")

	if got := names(mustLoad(t, s, claude)); strings.Join(got, ",") != "Work" {
		t.Errorf("profiles = %v", got)
	}
	if data, err := os.ReadFile(s.path + ".corrupt"); err != nil || string(data) != `{"claude":` {
		t.Errorf("quarantined file = %q, %v", data, err)
	}
}

// Changes from separate stores — separate processes, as far as the file lock
// is concerned, since it is held per open handle — never overwrite each other.
func TestConcurrentChangesAreAllKept(t *testing.T) {
	configDir := t.TempDir()
	const writers = 8
	const perWriter = 5

	var wg sync.WaitGroup
	errs := make(chan error, writers*perWriter*2)
	for w := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s := NewStore(configDir)
			agent := claude
			if w%2 == 1 {
				agent = codex
			}
			for i := range perWriter {
				p, err := s.Add(agent, fmt.Sprintf("writer %d profile %d", w, i))
				if err != nil {
					errs <- err
					continue
				}
				if err := s.SetCurrent(agent, p.ID); err != nil {
					errs <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent change: %v", err)
	}

	s := NewStore(configDir)
	for _, agent := range []session.AgentType{claude, codex} {
		l := mustLoad(t, s, agent)
		if want := writers / 2 * perWriter; len(l.Profiles) != want {
			t.Errorf("%s has %d profiles, want %d", agent, len(l.Profiles), want)
		}
		if l.index(l.Current) < 0 {
			t.Errorf("%s current %q is not one of its profiles", agent, l.Current)
		}
	}
}

// The file is the user's to edit: what they may leave in it reads as the
// default profile rather than breaking a change.
func TestHandEditedFile(t *testing.T) {
	for _, tt := range []struct {
		name     string
		contents string
	}{
		{"null", `null`},
		{"current naming no profile", `{"claude":{"current":"019f0000-0000-7000-8000-000000000000","profiles":[]}}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := NewStore(t.TempDir())
			if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(s.path, []byte(tt.contents), 0600); err != nil {
				t.Fatal(err)
			}

			if l := mustLoad(t, s, claude); l.Current != "" {
				t.Errorf("Load current = %q, want the default profile", l.Current)
			}
			if p, err := s.Current(claude); err != nil || p != nil {
				t.Errorf("Current = %+v, %v; want the default profile", p, err)
			}
			p := mustAdd(t, s, claude, "Work")
			if err := s.SetCurrent(claude, p.ID); err != nil {
				t.Fatalf("SetCurrent: %v", err)
			}
		})
	}
}

// An ID that could not name a directory is refused before anything changes.
func TestRemoveRejectsMalformedID(t *testing.T) {
	s := NewStore(t.TempDir())
	mustAdd(t, s, claude, "Work")
	if err := s.Remove(claude, "../.."); !errors.Is(err, ErrNotFound) {
		t.Errorf("Remove: %v, want ErrNotFound", err)
	}
	if got := names(mustLoad(t, s, claude)); len(got) != 1 {
		t.Errorf("profiles = %v", got)
	}
}
