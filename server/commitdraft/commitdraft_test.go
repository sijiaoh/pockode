package commitdraft

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/git"
)

type fakeRunner struct {
	answer string
	got    *agent.OneShotRequest
}

func (f *fakeRunner) RunOneShot(_ context.Context, req agent.OneShotRequest) (string, error) {
	f.got = &req
	return f.answer, nil
}

func repoWithStagedFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"config", "user.email", "test@test.com"},
		{"config", "user.name", "Test"},
		{"config", "commit.gpgsign", "false"},
		{"commit", "--allow-empty", "-m", "feat: start"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "div.go"), []byte("package calc\n"), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "add", "div.go")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, out)
	}
	return dir
}

func TestDraft(t *testing.T) {
	t.Run("asks once, in the repository, with the change and the history", func(t *testing.T) {
		dir := repoWithStagedFile(t)
		runner := &fakeRunner{answer: "feat: add div\n"}

		got, err := Draft(context.Background(), runner, Options{Dir: dir, Model: "sonnet", Effort: "low"})
		if err != nil || got != "feat: add div" {
			t.Fatalf("Draft = %q, %v", got, err)
		}
		if runner.got.WorkDir != dir || runner.got.Model != "sonnet" || runner.got.Effort != "low" {
			t.Errorf("asked with %+v, want the repository and the engine's model and effort", runner.got)
		}
		for _, want := range []string{"+package calc", "div.go", "<message>\nfeat: start\n</message>"} {
			if !strings.Contains(runner.got.Prompt, want) {
				t.Errorf("prompt lacks %q:\n%s", want, runner.got.Prompt)
			}
		}
	})

	t.Run("nothing staged asks nobody", func(t *testing.T) {
		dir := repoWithStagedFile(t)
		cmd := exec.Command("git", "reset", "-q")
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git reset: %v\n%s", err, out)
		}
		runner := &fakeRunner{}

		if _, err := Draft(context.Background(), runner, Options{Dir: dir}); !errors.Is(err, git.ErrNothingStaged) {
			t.Fatalf("got %v, want ErrNothingStaged", err)
		}
		if runner.got != nil {
			t.Error("the CLI was asked about an empty change")
		}
	})

	t.Run("an empty answer is a failure, not an empty message", func(t *testing.T) {
		dir := repoWithStagedFile(t)
		_, err := Draft(context.Background(), &fakeRunner{answer: "  \n"}, Options{Dir: dir})
		if !errors.Is(err, ErrEmptyAnswer) {
			t.Fatalf("got %v, want ErrEmptyAnswer", err)
		}
	})

	t.Run("a draft cancelled before it starts asks nobody", func(t *testing.T) {
		dir := repoWithStagedFile(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		runner := &fakeRunner{}

		if _, err := Draft(ctx, runner, Options{Dir: dir}); !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v, want context.Canceled", err)
		}
		if runner.got != nil {
			t.Error("the CLI was started for a cancelled draft")
		}
	})
}

func TestCleanAnswer(t *testing.T) {
	tests := []struct {
		name, in, want string
	}{
		{"plain", "Add div\n\nWhy it matters.\n", "Add div\n\nWhy it matters."},
		{"fenced", "```\nAdd div\n```", "Add div"},
		{"fenced with an info string", "```text\nAdd div\n\nBody.\n```\n", "Add div\n\nBody."},
		{"a fence inside the body is left alone", "Add div\n\n```\ncode\n```\nmore", "Add div\n\n```\ncode\n```\nmore"},
		{"quoted", "\"Add div\"", "Add div"},
		{"typographic quotes", "“Add div”", "Add div"},
		{"a quote that belongs to the message is kept", "\"Revert \"Add div\"\"", "\"Revert \"Add div\"\""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanAnswer(tt.in); got != tt.want {
				t.Errorf("cleanAnswer(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
