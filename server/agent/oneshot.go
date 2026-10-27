package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"

	"github.com/pockode/server/session"
)

// OneShotRunner is implemented by an agent that can answer a single prompt
// outside any session: no history, no process kept afterwards, and no tools.
//
// It exists for features where the user asks for one piece of text and gets it
// back — drafting a commit message is the first — and where nothing the agent
// does may reach the project. "No tools" is the contract an implementation owes
// its caller: it switches off every tool its CLI lets it switch off, and fails
// with ErrOneShotToolUse rather than return an answer from a run in which the
// model called one anyway.
type OneShotRunner interface {
	RunOneShot(ctx context.Context, req OneShotRequest) (string, error)
}

// OneShotRequest is one prompt for a OneShotRunner.
type OneShotRequest struct {
	// WorkDir is where the CLI runs. It reads its project-level settings and
	// instructions from there (CLAUDE.md, AGENTS.md), which is what a question
	// about the project should be answered with.
	WorkDir string
	// Prompt is handed over on stdin, never on the command line: it can be far
	// longer than a command line may be (32 KiB on Windows, 8 KiB through the
	// .cmd wrapper npm installs), and the wrapper refuses newlines outright.
	Prompt string
	// Model and Effort are the agent-specific ids a session takes
	// (session.ModelsForAgent, session.EffortsForAgent), validated by the
	// caller. Empty passes nothing and lets the CLI decide.
	Model  string
	Effort string
}

// ErrOneShotToolUse reports a one-shot run in which the model called a tool.
// The run is stopped there and its answer discarded.
var ErrOneShotToolUse = errors.New("the AI CLI tried to use a tool, which a one-shot request does not allow")

// OneShotAuthError reports a one-shot run the CLI's provider refused for its
// credentials: the CLI is not signed in, or its sign-in has expired.
type OneShotAuthError struct {
	Agent session.AgentType
	// Message is the CLI's own account of the refusal.
	Message string
}

func (e *OneShotAuthError) Error() string {
	return fmt.Sprintf("%s is not signed in: %s", e.Agent, e.Message)
}

// OneShotFailedError reports a one-shot run the CLI ended without an answer,
// carrying what it said about why.
type OneShotFailedError struct {
	Message string
}

func (e *OneShotFailedError) Error() string { return e.Message }

// maxOneShotStderr bounds what is kept of a one-shot CLI's stderr: it is only
// read to explain a failure, and the explanation is at its tail.
const maxOneShotStderr = 16 << 10

// RunStream runs an AI CLI to completion like Run, but writes input to its
// stdin and hands each line of its stdout to onLine as it arrives.
//
// It is the shape of a one-shot request: the prompt is too long for a command
// line, and the output has to be read while the CLI runs so that a run going
// somewhere it must not (a tool call) can be stopped at once instead of being
// waited out. When onLine returns an error the CLI's whole process tree is
// killed and that error is returned.
//
// As with Run, a non-zero exit is not an error: the returned RunResult carries
// the exit code and stderr (Stdout is left empty — it went to onLine). err is
// onLine's error, ctx.Err() when ctx ended first, a *BinaryNotFoundError, or a
// failure to run the CLI at all.
func RunStream(ctx context.Context, log *slog.Logger, name, dir string, args []string, input string, onLine func(line []byte) error) (RunResult, error) {
	procCtx, stop := context.WithCancel(ctx)
	defer stop()

	proc, err := StartProcess(procCtx, log, name, args, dir)
	if err != nil {
		return RunResult{}, err
	}

	go func() {
		// A CLI that dies before reading all of it closes the pipe on us; what it
		// printed on the way out is the account of that, not this write error.
		if _, err := io.WriteString(proc.Stdin, input); err != nil {
			log.Debug("AI CLI stopped reading its input", "cli", name, "error", err)
		}
		if err := proc.Stdin.Close(); err != nil {
			log.Debug("failed to close stdin of AI CLI", "cli", name, "error", err)
		}
	}()

	stderrDone := make(chan string, 1)
	go func() {
		tail := tailBuffer{max: maxOneShotStderr}
		// A read error only ends the account early; what was read is kept.
		_, _ = io.Copy(&tail, proc.Stderr)
		stderrDone <- string(tail.buf)
	}()

	var lineErr error
	scanner := NewLineScanner(proc.Stdout, MaxLineBytes)
	for scanner.Scan() {
		if lineErr = onLine(scanner.Bytes()); lineErr != nil {
			stop()
			break
		}
	}
	if lineErr != nil {
		// Drain so the reader goroutines can finish once the tree is gone.
		_, _ = io.Copy(io.Discard, proc.Stdout)
	}

	waitErr := proc.Wait()
	stderr := <-stderrDone
	proc.OutputDone()

	if lineErr != nil {
		return RunResult{}, lineErr
	}
	if ctx.Err() != nil {
		return RunResult{}, ctx.Err()
	}
	if err := scanner.Err(); err != nil {
		return RunResult{}, fmt.Errorf("read output of %s: %w", name, err)
	}

	result := RunResult{Stderr: stderr}
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

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	buf []byte
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		// Copied rather than resliced, so the bytes dropped are released.
		t.buf = append([]byte(nil), t.buf[len(t.buf)-t.max:]...)
	}
	return len(p), nil
}

// OneShotUnreadableError is the error for a line of a one-shot CLI's output
// that is JSON but not in the shape the reader needs to tell whether it is a
// tool call. The run is stopped rather than the line skipped: skipping would
// let exactly the frame that matters through unread.
func OneShotUnreadableError(name string, err error) error {
	return &OneShotFailedError{Message: fmt.Sprintf("could not read the output of %s, so the run was stopped: %v", name, err)}
}

// OneShotExitError is the error for a one-shot CLI that exited without having
// said, in its output, how the run ended — so stderr is all there is to go on.
func OneShotExitError(name string, res RunResult) error {
	msg := strings.TrimSpace(res.Stderr)
	if msg == "" {
		msg = "no output"
	}
	return &OneShotFailedError{Message: fmt.Sprintf("%s exited with status %d without an answer: %s", name, res.ExitCode, msg)}
}
