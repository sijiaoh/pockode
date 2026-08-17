package agent

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pockode/server/logger"
)

const StderrReadTimeout = 5 * time.Second

// outputDrainTimeout bounds how long the output pipes stay open after the child
// has been reaped and its process tree terminated. It only comes into play when
// a descendant escaped the tree (e.g. it re-parented itself into a new session);
// once it elapses the pipes are closed so readers see EOF instead of blocking
// forever.
const outputDrainTimeout = 3 * time.Second

// Process is an AI CLI subprocess plus the platform mechanism that terminates
// its entire process tree. It exists because exec.Cmd alone gets two things
// wrong for this workload:
//
//   - Killing the child is not killing the tree. AI CLIs spawn processes of
//     their own (shell commands, MCP servers), and on Windows npm installs
//     `claude` as `claude.cmd`, so the direct child is a cmd.exe wrapper and the
//     real node process is a grandchild. Terminating only the direct child
//     leaves those behind as orphans.
//
//   - Reaping must not depend on the pipes. Descendants inherit the stdout and
//     stderr write ends, so those pipes do not reach EOF while any of them is
//     alive. Cmd.StdoutPipe must not be read after Wait, which forces callers
//     into "drain, then Wait" — and that deadlocks outright the moment an orphan
//     survives: the drain never finishes, so Wait is never called, so the
//     session never ends and its worktree can never be removed. Process supplies
//     its own os.Pipe files instead, which keeps Wait dependent only on the
//     direct child, and reaps it concurrently with the drain.
type Process struct {
	cmd   *exec.Cmd
	group *processGroup
	log   *slog.Logger

	// Stdin is the write end of the child's stdin. Closing it is how a CLI is
	// asked to shut down on its own; Process closes it too once the child is
	// gone, so a caller that never does is not a leak.
	Stdin io.WriteCloser
	// Stdout and Stderr are the parent ends of the child's output streams. They
	// are plain Readers because closing them is Process's job, not the caller's;
	// stdoutR and stderrR are the files behind them.
	Stdout io.Reader
	Stderr io.Reader

	stdoutR *os.File
	stderrR *os.File
	// pipesClosed marks that close as deliberate, so pipeReader can report it as
	// a clean EOF rather than a stream error the user would see.
	pipesClosed atomic.Bool

	exited  chan struct{}
	waitErr error

	outputDone    chan struct{}
	outputOnce    sync.Once
	terminateOnce sync.Once

	// escapedTree records that the drain backstop had to force the pipes shut,
	// i.e. something outlived the tree termination. It should never happen; when
	// it does, orphans are the explanation for whatever goes wrong next.
	escapedTree atomic.Bool
}

// StartProcess launches an AI CLI in its own process tree and starts reaping it
// in the background. The whole tree is terminated when ctx is cancelled, when
// Terminate is called, or once the direct child exits on its own.
func StartProcess(ctx context.Context, log *slog.Logger, name string, args []string, dir string) (*Process, error) {
	// Resolved before anything is allocated: a CLI that cannot be found or
	// cannot be called safely is a user-environment problem, and there is no
	// point building pipes for it.
	cmd, err := Command(name, args...)
	if err != nil {
		return nil, err
	}

	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		closeFiles(stdinR, stdinW)
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		closeFiles(stdinR, stdinW, stdoutR, stdoutW)
		return nil, fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	cmd.Dir = dir
	// Handing exec.Cmd *os.File values (rather than an arbitrary io.Reader) makes
	// it pass the descriptors straight to the child: no copying goroutines, and
	// nothing for Wait to synchronise on.
	cmd.Stdin = stdinR
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW

	group := newProcessGroup(cmd)

	if err := cmd.Start(); err != nil {
		group.close()
		closeFiles(stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW)
		return nil, err
	}

	// The child holds its own duplicates now. The parent's copies of the child's
	// ends have to go, or the pipes could never reach EOF.
	closeFiles(stdinR, stdoutW, stderrW)

	p := &Process{
		cmd:        cmd,
		group:      group,
		log:        log,
		Stdin:      stdinW,
		stdoutR:    stdoutR,
		stderrR:    stderrR,
		exited:     make(chan struct{}),
		outputDone: make(chan struct{}),
	}
	p.Stdout = pipeReader{f: stdoutR, closed: &p.pipesClosed}
	p.Stderr = pipeReader{f: stderrR, closed: &p.pipesClosed}

	if err := group.adopt(cmd); err != nil {
		// Not fatal: the direct child can still be killed, we just lose the
		// guarantee about its descendants. Surface it so orphans are explainable.
		log.Warn("failed to attach process tree tracking", "error", err, "pid", cmd.Process.Pid)
	}

	go p.reap()
	go func() {
		select {
		case <-ctx.Done():
			p.Terminate()
		case <-p.exited:
		}
	}()

	return p, nil
}

// Pid returns the process ID of the direct child.
func (p *Process) Pid() int {
	return p.cmd.Process.Pid
}

// Wait blocks until the child has been reaped and returns its exit error.
// Unlike exec.Cmd.Wait it does not wait on the output pipes, so a descendant
// still holding them cannot stall it. Safe to call from multiple goroutines.
func (p *Process) Wait() error {
	<-p.exited
	return p.waitErr
}

// OutputDone tells Process that the caller has finished reading Stdout *and*
// Stderr, which lets it close the pipes immediately instead of waiting out the
// drain timeout. Signalling it while stderr is still being collected truncates
// whatever is left in that pipe — which is exactly the CLI's own account of why
// it died. WaitForProcess calls this once both are done, so callers using it do
// not have to.
func (p *Process) OutputDone() {
	p.outputOnce.Do(func() { close(p.outputDone) })
}

// Terminate kills the child and every process it spawned. Safe to call more
// than once and after the child has already exited.
func (p *Process) Terminate() {
	p.terminateOnce.Do(func() {
		if err := p.group.terminate(); err != nil {
			// Fall back to the direct child so the session cannot hang on a
			// platform mechanism that failed to initialise. Its descendants may
			// survive, which is worth saying out loud: they are the explanation
			// for any worktree that then refuses to be removed.
			p.log.Warn("cannot terminate process tree, killing only the direct child; descendants may survive",
				"error", err, "pid", p.Pid())
			if err := p.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				p.log.Error("failed to kill process", "error", err, "pid", p.Pid())
			}
		}
	})
}

func (p *Process) reap() {
	defer func() {
		if r := recover(); r != nil {
			logger.LogPanic(r, "failed to reap AI CLI process")
		}
	}()

	p.waitErr = p.cmd.Wait()
	close(p.exited)

	// The direct child is gone; anything still holding the output pipes outlived
	// it. Take the tree down so readers reach EOF.
	p.Terminate()

	select {
	case <-p.outputDone:
	case <-time.After(outputDrainTimeout):
		p.escapedTree.Store(true)
		p.log.Warn("output pipes still held after process tree termination, closing", "pid", p.Pid())
	}

	// Release the tree handle before the pipes: termination is asynchronous, so
	// a straggler may still be exiting, and on Windows releasing the job is what
	// finishes it off — which in turn frees the pipe ends we are about to close.
	p.group.close()

	p.pipesClosed.Store(true)
	closeFiles(p.stdoutR, p.stderrR)
	p.Stdin.Close()
}

// pipeReader reports a pipe that Process closed on purpose as a clean EOF.
// Without this the drain backstop would surface to the user as a stream error.
type pipeReader struct {
	f      *os.File
	closed *atomic.Bool
}

func (r pipeReader) Read(b []byte) (int, error) {
	n, err := r.f.Read(b)
	if err != nil && errors.Is(err, os.ErrClosed) && r.closed.Load() {
		err = io.EOF
	}
	return n, err
}

func closeFiles(files ...*os.File) {
	for _, f := range files {
		f.Close()
	}
}

// ReadStderr collects all stderr output from a subprocess into a channel.
// The returned channel receives the full stderr content when the reader is exhausted.
func ReadStderr(stderr io.Reader, agentName string) <-chan string {
	ch := make(chan string, 1)
	go func() {
		var content strings.Builder
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, fmt.Sprintf("failed to read %s stderr", agentName))
			}
			ch <- content.String()
		}()
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			content.WriteString(scanner.Text())
			content.WriteString("\n")
		}
		if err := scanner.Err(); err != nil {
			slog.Error("stderr scanner error", "error", err)
		}
	}()
	return ch
}

// WaitForProcess waits for a subprocess to exit and emits an ErrorEvent if it
// terminated unexpectedly (i.e. not due to context cancellation).
//
// Call it once stdout has been drained: collecting stderr is the last thing
// anyone reads from the process, so this is also where the output pipes are
// released.
func WaitForProcess(ctx context.Context, log *slog.Logger, proc *Process, stderrCh <-chan string, events chan<- AgentEvent) {
	var stderrContent string
	select {
	case stderrContent = <-stderrCh:
	case <-time.After(StderrReadTimeout):
	}
	proc.OutputDone()

	if err := proc.Wait(); err != nil {
		if ctx.Err() == nil {
			errMsg := stderrContent
			if errMsg == "" {
				errMsg = err.Error()
			}
			select {
			case events <- ErrorEvent{Error: errMsg}:
			case <-ctx.Done():
			}
		}
	}

	log.Info("process exited")
}
