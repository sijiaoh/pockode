package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"sync"
)

// RunResult is what a short-lived AI CLI invocation printed, and how it ended.
type RunResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// Run runs an AI CLI to completion — a one-shot command such as `auth status`,
// not a session — and returns what it printed.
//
// It goes through StartProcess rather than CommandContext + Output, for the two
// things a Windows server needs from a command it may have to give up on: the
// whole tree is killed when ctx is done (an npm-installed CLI is a grandchild of
// the cmd.exe wrapper exec knows about), and the CLI gets no console window of
// its own on a server that has none.
//
// A non-zero exit is not an error here: the auth commands answer through their
// exit status as much as through their output (`claude auth status` exits 1 when
// signed out, and still prints its JSON). err is kept for a CLI that could not be
// started — a *BinaryNotFoundError when it is not installed — or that did not
// finish before ctx was done, in which case it is ctx.Err().
//
// dir is where it runs, as with StartProcess: a CLI reads project-level
// settings from its working directory, so a command whose answer depends on
// them has to run where the sessions do. Empty is this process's own.
//
// stdin is closed at once, so a command that would wait for input ends instead.
func Run(ctx context.Context, log *slog.Logger, name, dir string, args ...string) (RunResult, error) {
	proc, err := StartProcess(ctx, log, name, args, dir)
	if err != nil {
		return RunResult{}, err
	}
	if err := proc.Stdin.Close(); err != nil {
		log.Warn("failed to close stdin of AI CLI command", "cli", name, "error", err)
	}

	var stdout, stderr []byte
	var stdoutErr, stderrErr error
	var reads sync.WaitGroup
	reads.Add(2)
	go func() {
		defer reads.Done()
		stdout, stdoutErr = io.ReadAll(proc.Stdout)
	}()
	go func() {
		defer reads.Done()
		stderr, stderrErr = io.ReadAll(proc.Stderr)
	}()

	waitErr := proc.Wait()
	reads.Wait()
	proc.OutputDone()

	if ctx.Err() != nil {
		return RunResult{}, ctx.Err()
	}
	if err := errors.Join(stdoutErr, stderrErr); err != nil {
		return RunResult{}, fmt.Errorf("read output of %s: %w", name, err)
	}

	result := RunResult{Stdout: string(stdout), Stderr: string(stderr)}
	var exitErr *exec.ExitError
	switch {
	case waitErr == nil:
	case errors.As(waitErr, &exitErr):
		result.ExitCode = exitErr.ExitCode()
	default:
		return RunResult{}, fmt.Errorf("run %s: %w", name, waitErr)
	}
	return result, nil
}
