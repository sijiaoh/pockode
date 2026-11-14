package cliprofile

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/pockode/server/session"
)

// preparing is a store with one profile of agent, and the default directory
// it shares, set the way the user's environment would.
type preparing struct {
	store      *Store
	agent      session.AgentType
	id         string
	dir        string
	defaultDir string
}

func newPreparing(t *testing.T, agent session.AgentType) *preparing {
	t.Helper()
	defaultDir := filepath.Join(t.TempDir(), "default")
	t.Setenv(layouts[agent].envVar, defaultDir)
	s := NewStore(t.TempDir())
	if a := s.Availability(); !a.Available {
		t.Skipf("profiles are unavailable on this machine: %s", a.Reason)
	}
	p := mustAdd(t, s, agent, "Work")
	dir, err := s.Dir(agent, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	return &preparing{store: s, agent: agent, id: p.ID, dir: dir, defaultDir: defaultDir}
}

// inDefault creates entries in the default directory; a trailing slash makes
// a directory.
func (p *preparing) inDefault(t *testing.T, names ...string) {
	t.Helper()
	for _, name := range names {
		makeEntry(t, p.defaultDir, name)
	}
}

func makeEntry(t *testing.T, base, name string) {
	t.Helper()
	if dir, ok := strings.CutSuffix(name, "/"); ok {
		if err := os.MkdirAll(filepath.Join(base, dir), 0o700); err != nil {
			t.Fatal(err)
		}
		return
	}
	path := filepath.Join(base, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(filepath.Base(path)), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (p *preparing) prepare(t *testing.T) []Conflict {
	t.Helper()
	conflicts, err := p.store.Prepare(p.agent, p.id)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	return conflicts
}

// assertLinked checks each name in the profile is a link to the default
// directory's entry of that name, and that the entry exists.
func (p *preparing) assertLinked(t *testing.T, names ...string) {
	t.Helper()
	for _, name := range names {
		target := filepath.Join(p.defaultDir, name)
		if !pointsAt(filepath.Join(p.dir, name), target) {
			t.Errorf("%s is not a link to %s", name, target)
		}
		if _, err := os.Stat(target); err != nil {
			t.Errorf("%s links to a missing target: %v", name, err)
		}
	}
}

func (p *preparing) assertAbsent(t *testing.T, names ...string) {
	t.Helper()
	for _, name := range names {
		if _, err := os.Lstat(filepath.Join(p.dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s should not be in the profile directory (err %v)", name, err)
		}
	}
}

func conflictNames(cs []Conflict) []string {
	var out []string
	for _, c := range cs {
		out = append(out, c.Name)
	}
	slices.Sort(out)
	return out
}

func TestPrepareClaudeLinksAllButCredentials(t *testing.T) {
	p := newPreparing(t, claude)
	p.inDefault(t, "settings.json", "history.jsonl", "plugins/", "skills/",
		".credentials.json", ".claude.json", ".claude.json.backup", "sessions/", "backups/")

	if c := p.prepare(t); len(c) != 0 {
		t.Fatalf("conflicts = %v, want none", c)
	}

	p.assertLinked(t, "settings.json", "history.jsonl", "plugins", "skills", "projects")
	p.assertAbsent(t, ".credentials.json", ".claude.json", ".claude.json.backup", "sessions", "backups")
}

func TestPrepareCodexLinksAllButCredentialsAndLogs(t *testing.T) {
	p := newPreparing(t, codex)
	p.inDefault(t, "config.toml", "state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm", "skills/",
		"auth.json", "auth.json.lock", "auth.lock", "logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite-shm",
		"tmp/", ".tmp/", "shell_snapshots/")

	p.prepare(t)

	p.assertLinked(t, "config.toml", "skills", "sessions", "thread-writer-locks")
	// A database's -wal and -shm stay with it: linking them alone would pair
	// the profile's database with the default one's log.
	p.assertAbsent(t, "auth.json", "auth.json.lock", "auth.lock", "logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite-shm",
		"tmp", ".tmp", "shell_snapshots")
	// Shared only where SQLite follows the link to the real database (see
	// codexPlatformPrivate).
	state := []string{"state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"}
	if len(codexPlatformPrivate) == 0 {
		p.assertLinked(t, state...)
	} else {
		p.assertAbsent(t, state...)
	}
}

// The shared entries are linked even before the default directory has them —
// even before it exists — and never left dangling: a CLI creating a session
// under a dangling link fails.
func TestPrepareCreatesSharedTargets(t *testing.T) {
	p := newPreparing(t, codex)

	p.prepare(t)

	for _, name := range []string{"sessions", "thread-writer-locks"} {
		info, err := os.Stat(filepath.Join(p.defaultDir, name))
		if err != nil || !info.IsDir() {
			t.Fatalf("default %s was not created as a directory: %v", name, err)
		}
	}
	p.assertLinked(t, "sessions", "thread-writer-locks")

	// Writing through the link lands in the default directory.
	if err := os.MkdirAll(filepath.Join(p.dir, "sessions", "2026", "11"), 0o700); err != nil {
		t.Fatalf("creating under the shared link: %v", err)
	}
	if _, err := os.Stat(filepath.Join(p.defaultDir, "sessions", "2026", "11")); err != nil {
		t.Fatalf("not in the default directory: %v", err)
	}
}

func TestPrepareIsIdempotentAndPicksUpNewEntries(t *testing.T) {
	p := newPreparing(t, claude)
	p.inDefault(t, "settings.json")
	p.prepare(t)
	if c := p.prepare(t); len(c) != 0 {
		t.Fatalf("second Prepare reported conflicts: %v", c)
	}
	p.assertLinked(t, "settings.json", "projects")

	// A CLI update adds something to the default directory.
	p.inDefault(t, "new-feature/")
	p.prepare(t)
	p.assertLinked(t, "new-feature")
}

// Pockode processes may prepare the same profile at the same moment.
func TestPrepareConcurrently(t *testing.T) {
	p := newPreparing(t, claude)
	p.inDefault(t, "settings.json", "plugins/", "history.jsonl")

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Go(func() {
			if _, err := p.store.Prepare(p.agent, p.id); err != nil {
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	p.assertLinked(t, "settings.json", "plugins", "history.jsonl", "projects")
}

// What should be shared but is the profile's own is reported and left alone:
// it may be a database the CLI has open.
func TestPrepareLeavesConflictsInPlace(t *testing.T) {
	p := newPreparing(t, codex)
	p.inDefault(t, "history.jsonl", "config.toml", "auth.json")
	makeEntry(t, p.dir, "history.jsonl")
	makeEntry(t, p.dir, "sessions/rollout.jsonl")
	makeEntry(t, p.dir, "auth.json")

	got := conflictNames(p.prepare(t))

	want := []string{"history.jsonl", "sessions"}
	if !slices.Equal(got, want) {
		t.Fatalf("conflicts = %v, want %v", got, want)
	}
	for _, name := range []string{"history.jsonl", "sessions/rollout.jsonl", "auth.json"} {
		if data, err := os.ReadFile(filepath.Join(p.dir, name)); err != nil || string(data) != filepath.Base(name) {
			t.Errorf("the profile's own %s was touched: %q, %v", name, data, err)
		}
	}
	p.assertLinked(t, "config.toml", "thread-writer-locks")

	read, err := p.store.Conflicts(p.agent, p.id)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(conflictNames(read), want) {
		t.Errorf("Conflicts = %v, want %v", conflictNames(read), want)
	}
}

func TestConflictsChangesNothing(t *testing.T) {
	p := newPreparing(t, claude)
	p.inDefault(t, "settings.json")

	got, err := p.store.Conflicts(p.agent, p.id)
	if err != nil || len(got) != 0 {
		t.Fatalf("Conflicts = %v, %v; want none", got, err)
	}
	if _, err := os.Lstat(p.dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Conflicts created the profile directory (err %v)", err)
	}
	if _, err := os.Lstat(filepath.Join(p.defaultDir, "projects")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Conflicts created a shared target (err %v)", err)
	}
}

// Links that should no longer be links go: one whose target left the default
// directory would dangle, one whose name became private would share
// credentials. Only the link is removed.
func TestPrepareDropsStaleLinks(t *testing.T) {
	p := newPreparing(t, claude)
	p.inDefault(t, "todos/", ".credentials.json")
	if err := os.MkdirAll(p.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"todos", ".credentials.json"} {
		if err := os.Symlink(filepath.Join(p.defaultDir, name), filepath.Join(p.dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(filepath.Join(p.defaultDir, "todos")); err != nil {
		t.Fatal(err)
	}

	p.prepare(t)

	p.assertAbsent(t, "todos", ".credentials.json")
	if _, err := os.Stat(filepath.Join(p.defaultDir, ".credentials.json")); err != nil {
		t.Errorf("the default credentials were touched: %v", err)
	}
}

// The user starts Pockode with a different CLAUDE_CONFIG_DIR. Links into the
// old directory are repointed once it is gone; while it exists another Pockode
// process may still be using it, so they are reported, not fought over.
func TestPrepareAfterTheDefaultDirectoryMoved(t *testing.T) {
	p := newPreparing(t, claude)
	old := p.defaultDir
	p.inDefault(t, "settings.json", "old-only/")
	p.prepare(t)

	moved := filepath.Join(t.TempDir(), "moved")
	t.Setenv("CLAUDE_CONFIG_DIR", moved)
	p.defaultDir = moved
	p.inDefault(t, "settings.json")

	got := conflictNames(p.prepare(t))
	if want := []string{"projects", "settings.json"}; !slices.Equal(got, want) {
		t.Fatalf("conflicts with the old directory still there = %v, want %v", got, want)
	}
	if !pointsAt(filepath.Join(p.dir, "settings.json"), filepath.Join(old, "settings.json")) {
		t.Error("a link into the old, still existing directory was repointed")
	}

	if err := os.RemoveAll(old); err != nil {
		t.Fatal(err)
	}
	if c := p.prepare(t); len(c) != 0 {
		t.Fatalf("conflicts once the old directory is gone = %v, want none", c)
	}
	p.assertLinked(t, "settings.json", "projects")
	p.assertAbsent(t, "old-only")
}

// A Remove landing while Prepare fills the directory in must not leave the
// directory behind, credentials and all.
func TestPrepareUndoesARemoveMeanwhile(t *testing.T) {
	p := newPreparing(t, claude)
	testHookLinked = func() {
		if err := p.store.Remove(p.agent, p.id); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { testHookLinked = nil })

	if _, err := p.store.Prepare(p.agent, p.id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Prepare = %v, want ErrNotFound", err)
	}
	if _, err := os.Lstat(p.dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the removed profile's directory is back (err %v)", err)
	}
}

// A profile file damaged by hand while Prepare runs says nothing about the
// profile being gone; its directory stays.
func TestPrepareKeepsTheDirectoryOverADamagedFile(t *testing.T) {
	p := newPreparing(t, claude)
	testHookLinked = func() {
		if err := os.WriteFile(p.store.path, []byte("{oops"), 0o600); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { testHookLinked = nil })

	if _, err := p.store.Prepare(p.agent, p.id); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("Prepare = %v, want an error about the file", err)
	}
	if _, err := os.Stat(p.dir); err != nil {
		t.Errorf("the profile directory was removed: %v", err)
	}
}

func TestPrepareRefusesUnlistedProfile(t *testing.T) {
	p := newPreparing(t, claude)
	if err := p.store.Remove(p.agent, p.id); err != nil {
		t.Fatal(err)
	}

	if _, err := p.store.Prepare(p.agent, p.id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Prepare of a removed profile = %v, want ErrNotFound", err)
	}
	if _, err := os.Lstat(p.dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the removed profile's directory was created (err %v)", err)
	}
}

// A default directory that is itself a profile's — Pockode started from a CLI
// running on one — is refused rather than linked into another profile.
func TestPrepareRefusesAProfileAsTheDefault(t *testing.T) {
	p := newPreparing(t, claude)
	other := mustAdd(t, p.store, claude, "Other")
	otherDir, err := p.store.Dir(claude, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", otherDir)

	if _, err := p.store.Prepare(claude, p.id); err == nil {
		t.Fatal("Prepare succeeded with a profile directory as the default")
	}
	if _, err := os.Lstat(p.dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the profile directory was created (err %v)", err)
	}
}

func TestPrepareRefusesWithoutSymlinks(t *testing.T) {
	defaultDir := filepath.Join(t.TempDir(), "default")
	t.Setenv("CLAUDE_CONFIG_DIR", defaultDir)
	s := NewStore(t.TempDir())
	s.availabilityOnce.Do(func() { s.availability = Availability{Reason: "no symlinks here"} })
	p := mustAdd(t, s, claude, "Work")

	_, err := s.Prepare(claude, p.ID)

	if !errors.Is(err, ErrSymlinksUnavailable) {
		t.Fatalf("Prepare = %v, want ErrSymlinksUnavailable", err)
	}
	if _, err := os.Lstat(defaultDir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Prepare created the default directory (err %v)", err)
	}
}

// The probe answers, and leaves nothing behind where profiles live.
func TestAvailabilityProbeCleansUp(t *testing.T) {
	configDir := t.TempDir()
	s := NewStore(configDir)

	a := s.Availability()

	if a.Available != (a.Reason == "") {
		t.Fatalf("Availability = %+v: a reason exactly when unavailable", a)
	}
	entries, err := os.ReadDir(filepath.Join(configDir, "pockode"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("probe left %v behind", entries)
	}
}

func TestDefaultDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	for agent, l := range layouts {
		t.Setenv(l.envVar, "")
		got, err := DefaultDir(agent)
		if err != nil || got != filepath.Join(home, l.homeDir) {
			t.Errorf("DefaultDir(%s) without %s = %q, %v", agent, l.envVar, got, err)
		}

		custom := filepath.Join(t.TempDir(), "custom")
		t.Setenv(l.envVar, custom)
		got, err = DefaultDir(agent)
		if err != nil || got != custom {
			t.Errorf("DefaultDir(%s) with %s = %q, %v; want %q", agent, l.envVar, got, err, custom)
		}
	}

	if _, err := DefaultDir("gemini"); !errors.Is(err, ErrUnsupportedAgent) {
		t.Errorf("DefaultDir(gemini) = %v, want ErrUnsupportedAgent", err)
	}
}
