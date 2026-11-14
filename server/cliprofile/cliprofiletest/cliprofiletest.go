// Package cliprofiletest sets up AI CLI profiles for tests of the code that
// starts the CLIs, and records what a fake CLI was started with, so a test can
// check that every start runs as the profile it should.
package cliprofiletest

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/session"
)

// LaunchEnv are the variables a profile is selected by. Pockode sets them
// only for a CLI it starts as a non-default profile.
var LaunchEnv = []string{"CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME"}

var defaultDirEnv = map[session.AgentType]string{
	session.AgentTypeClaude: "CLAUDE_CONFIG_DIR",
	session.AgentTypeCodex:  "CODEX_HOME",
}

// Fixture is a profile store of the test's own. Both CLIs' default
// directories are temporary ones, given the way a user would give them — in
// CLAUDE_CONFIG_DIR and CODEX_HOME — so nothing the test prepares reaches the
// real ~/.claude or ~/.codex. The test cannot be parallel.
type Fixture struct {
	Store       *cliprofile.Store
	defaultDirs map[session.AgentType]string
}

func New(t *testing.T) *Fixture {
	t.Helper()
	f := &Fixture{Store: cliprofile.NewStore(t.TempDir()), defaultDirs: map[session.AgentType]string{}}
	for _, name := range LaunchEnv {
		unsetenv(t, name)
	}
	for agent, name := range defaultDirEnv {
		dir := filepath.Join(t.TempDir(), "default-"+string(agent))
		t.Setenv(name, dir)
		f.defaultDirs[agent] = dir
	}
	return f
}

// UserStore is the store Pockode itself uses, for the suites that run the real
// CLIs: they run as the user's current profile, as a session would. Nil — the
// default profiles only — where there is no configuration directory, as in
// Pockode.
func UserStore() *cliprofile.Store {
	s, _ := cliprofile.DefaultStore()
	return s
}

// DefaultDir is agent's default directory, as the fake CLI sees it in its
// environment when started as the default profile.
func (f *Fixture) DefaultDir(agent session.AgentType) string { return f.defaultDirs[agent] }

// UseProfile adds a profile of agent, makes it current and returns its ID and
// directory. It skips the test on a machine that cannot have profiles
// (Windows without Developer Mode).
func (f *Fixture) UseProfile(t *testing.T, agent session.AgentType) (id, dir string) {
	t.Helper()
	if a := f.Store.Availability(); !a.Available {
		t.Skipf("profiles are unavailable on this machine: %s", a.Reason)
	}
	p, err := f.Store.Add(agent, "Work")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Store.SetCurrent(agent, p.ID); err != nil {
		t.Fatal(err)
	}
	dir, err = f.Store.Dir(agent, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	return p.ID, dir
}

// FakeOnPath puts a copy of the test binary first on PATH as name, so that
// code starting the CLI by name starts the test binary in its place; the
// test's TestMain plays the CLI.
func FakeOnPath(t *testing.T, name string) {
	t.Helper()
	exe, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatalf("read test binary: %v", err)
	}
	dir := t.TempDir()
	// Windows finds a program by its extension; elsewhere the test binary's
	// own (".test") would make it another name.
	if strings.EqualFold(filepath.Ext(os.Args[0]), ".exe") {
		name += ".exe"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, exe, 0o755); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// recordEnv names the file a fake CLI records each start of itself in.
const recordEnv = "POCKODE_TEST_CLI_RECORD"

// Invocation is one start of a fake CLI.
type Invocation struct {
	Args []string `json:"args"`
	// Env holds those of LaunchEnv that were set.
	Env map[string]string `json:"env"`
}

// Recorder collects every start of a fake CLI from the moment Record is
// called — in this process's children, which inherit where to write.
type Recorder struct {
	path string
}

func Record(t *testing.T) *Recorder {
	t.Helper()
	path := filepath.Join(t.TempDir(), "invocations.jsonl")
	t.Setenv(recordEnv, path)
	return &Recorder{path: path}
}

// Invocations are the starts recorded so far, in order.
func (r *Recorder) Invocations(t *testing.T) []Invocation {
	t.Helper()
	out, err := r.read()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (r *Recorder) read() ([]Invocation, error) {
	data, err := os.ReadFile(r.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Invocation
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var inv Invocation
		if err := json.Unmarshal([]byte(line), &inv); err != nil {
			return nil, fmt.Errorf("read invocation %q: %w", line, err)
		}
		out = append(out, inv)
	}
	return out, nil
}

// WaitFor waits for a start that match says is the one, for a CLI started in
// the background.
func (r *Recorder) WaitFor(t *testing.T, match func(Invocation) bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		// An error is a line still being written; the next read has it whole.
		if got, err := r.read(); err == nil && slices.ContainsFunc(got, match) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the CLI did not start within 10s")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// RecordInvocation is called by a fake CLI as it starts, with its arguments.
// It does nothing unless the test asked for a record.
func RecordInvocation(args []string) {
	path := os.Getenv(recordEnv)
	if path == "" {
		return
	}
	inv := Invocation{Args: args, Env: map[string]string{}}
	for _, name := range LaunchEnv {
		if v, ok := os.LookupEnv(name); ok {
			inv.Env[name] = v
		}
	}
	data, err := json.Marshal(inv)
	if err != nil {
		panic(err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if _, err := f.Write(append(data, '\n')); err != nil {
		panic(err)
	}
}

// unsetenv removes name for the rest of the test, restoring it afterwards.
func unsetenv(t *testing.T, name string) {
	t.Setenv(name, "")
	if err := os.Unsetenv(name); err != nil {
		t.Fatal(err)
	}
}
