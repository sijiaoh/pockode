package command

import (
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
)

func TestParsePockode(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    agent.CommandInvocation
		wantOK  bool
	}{
		{"bare", "/pockode-lead", agent.CommandInvocation{Name: "pockode-lead"}, true},
		{"args", "/pockode-lead  start with the API\n", agent.CommandInvocation{Name: "pockode-lead", Args: "start with the API"}, true},
		{"multiline args", "/pockode-lead\nfirst\nsecond", agent.CommandInvocation{Name: "pockode-lead", Args: "first\nsecond"}, true},
		// Still Pockode's, so that it is refused rather than sent on.
		{"unknown name", "/pockode-nope x", agent.CommandInvocation{Name: "pockode-nope", Args: "x"}, true},
		{"prefix alone", "/pockode-", agent.CommandInvocation{Name: "pockode-"}, true},
		{"other slash command", "/review", agent.CommandInvocation{}, false},
		{"no dash", "/pockode", agent.CommandInvocation{}, false},
		{"not at the start", "please run /pockode-lead", agent.CommandInvocation{}, false},
		{"plain text", "hello", agent.CommandInvocation{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ParsePockode(tt.content)
			if ok != tt.wantOK || got != tt.want {
				t.Errorf("ParsePockode(%q) = %+v, %v; want %+v, %v", tt.content, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestExpandPockode_UnknownNamesTheAvailableCommands(t *testing.T) {
	_, err := ExpandPockode(agent.CommandInvocation{Name: "pockode-nope"}, PockodeEnv{WorkDir: t.TempDir()})
	if !errors.Is(err, ErrUnknownPockodeCommand) {
		t.Fatalf("err = %v, want ErrUnknownPockodeCommand", err)
	}
	for _, want := range []string{"/pockode-nope", "/pockode-lead"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, want it to name %s", err, want)
		}
	}
}

func gitRepo(t *testing.T, branch string) string {
	t.Helper()
	dir := t.TempDir()
	runGit(t, dir, "init")
	runGit(t, dir, "symbolic-ref", "HEAD", "refs/heads/"+branch)
	return dir
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestExpandPockode_LeadMergesIntoTheWorktreesBranch(t *testing.T) {
	dir := gitRepo(t, "feature/x")

	got, err := ExpandPockode(agent.CommandInvocation{Name: "pockode-lead"}, PockodeEnv{WorkDir: dir})
	if err != nil {
		t.Fatalf("ExpandPockode: %v", err)
	}
	if !strings.Contains(got, "merge its branch into feature/x") {
		t.Errorf("prompt does not name the branch:\n%s", got)
	}
	if strings.Contains(got, "Additional instructions") {
		t.Errorf("prompt without args has an instructions section:\n%s", got)
	}
}

func TestExpandPockode_LeadAppendsTheArgs(t *testing.T) {
	dir := gitRepo(t, "main")

	got, err := ExpandPockode(agent.CommandInvocation{Name: "pockode-lead", Args: "API first\n{{.Branch}}"}, PockodeEnv{WorkDir: dir})
	if err != nil {
		t.Fatalf("ExpandPockode: %v", err)
	}
	// Verbatim, template syntax included: args are data, not template.
	if !strings.HasSuffix(got, "\n\nAdditional instructions from the user:\nAPI first\n{{.Branch}}") {
		t.Errorf("prompt does not end with the args:\n%s", got)
	}
}

func TestExpandPockode_LeadRefusesADetachedHead(t *testing.T) {
	dir := gitRepo(t, "main")
	runGit(t, dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false",
		"commit", "--allow-empty", "-m", "init")
	runGit(t, dir, "checkout", "--detach")

	_, err := ExpandPockode(agent.CommandInvocation{Name: "pockode-lead"}, PockodeEnv{WorkDir: dir})
	if !errors.Is(err, ErrNoBranch) {
		t.Fatalf("err = %v, want ErrNoBranch", err)
	}
}

// A branch that cannot be read at all is not the user's to fix by checking one
// out, so it is not worded as a refusal.
func TestExpandPockode_LeadFailsWithoutARepository(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(dir))

	_, err := ExpandPockode(agent.CommandInvocation{Name: "pockode-lead"}, PockodeEnv{WorkDir: dir})
	if err == nil || errors.Is(err, ErrNoBranch) {
		t.Fatalf("err = %v, want a failure that is not ErrNoBranch", err)
	}
}
