//go:build windows

package proctree

import (
	"fmt"
	"log/slog"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Tree tracks a child and its descendants through a Job Object.
//
// Windows has no process-group signalling comparable to Unix, and a Job Object
// is the only mechanism that covers a whole tree: a process created by a job
// member automatically joins the job, and TerminateJobObject ends every member
// at once.
type Tree struct {
	// treeMu orders Adopt against a Terminate arriving from elsewhere — an
	// exec.Cmd cancellation runs on a watchdog goroutine of its own, and nothing
	// stops the context from being done before the child has been attached — and
	// keeps either of them from racing Close for the handle.
	treeMu     sync.Mutex
	job        windows.Handle
	terminated bool
}

// New creates the job the child will be assigned to. Must be called before
// cmd.Start. JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is applied only when the caller
// asked for it; see KillOnClose for why that is not the default.
//
// CREATE_NEW_PROCESS_GROUP mirrors the Unix side, keeping a console Ctrl+C from
// reaching the child before the server can shut down what it started in order.
//
// CREATE_NO_WINDOW keeps the child's console off the screen. It matters most
// where the server has no console of its own — a node started by a cluster, a
// service, Task Scheduler — because Windows allocates a *visible* console for
// the first console program such a process starts, and every subprocess call
// would flash a black window at whoever is using the machine. Where the server
// does have a console the flag costs nothing that was being used: callers here
// hand the child pipes for all three of its streams, so nothing it writes was
// going to reach a console either way.
//
// Windows ignores CREATE_NO_WINDOW when it is combined with CREATE_NEW_CONSOLE
// or DETACHED_PROCESS, so the child must not be handed either of those as a way
// of keeping it off ours — the flag beside it here is not one of them.
func New(cmd *exec.Cmd, opts ...Option) *Tree {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW

	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		slog.Error("failed to create job object for subprocess", "error", err)
		return &Tree{}
	}

	if newSettings(opts).killOnClose {
		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
			BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
				LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
			},
		}
		if err := setJobLimits(job, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
			slog.Error("failed to configure job object for subprocess", "error", err)
			windows.CloseHandle(job)
			return &Tree{}
		}
	}

	return &Tree{job: job}
}

// setJobLimits forwards to SetInformationJobObject, which takes its payload as a
// uintptr rather than a pointer.
//
// That signature hides the pointer from the compiler: without the pragma below,
// the limit struct stays on the caller's stack, and a stack growth anywhere
// between the conversion and the syscall would move it — handing the kernel an
// address into freed memory. go:uintptrescapes forces such arguments onto the
// heap and keeps them alive for the whole call, which is the only way to make
// this API safe from Go.
//
//go:uintptrescapes
func setJobLimits(job windows.Handle, info uintptr, size uint32) error {
	_, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, info, size)
	return err
}

// Adopt puts the started child into the job.
//
// Windows offers no way to hand a job to CreateProcess through os/exec, so this
// necessarily happens just after the process exists. The child could in theory
// spawn a descendant in that window and leave it outside the job, but it has
// barely begun executing at this point, so the window is far shorter than any
// process startup.
//
// On failure the job is dropped rather than kept. An empty job is worse than no
// job: TerminateJobObject would report success on it, and the process it was
// meant to cover would keep running unnoticed. Releasing it makes Terminate
// report ErrUnavailable, so the caller falls back to the direct child.
//
// A Terminate that arrived first is for the same reason not enough on its own:
// it emptied a job the child had not joined yet. It is carried out again here,
// once there is something in the job for it to reach.
func (t *Tree) Adopt(cmd *exec.Cmd) error {
	t.treeMu.Lock()
	defer t.treeMu.Unlock()

	if t.job == 0 {
		return nil // Creation already failed and was reported.
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		t.closeLocked()
		return fmt.Errorf("open process: %w", err)
	}
	defer windows.CloseHandle(handle)

	if err := windows.AssignProcessToJobObject(t.job, handle); err != nil {
		t.closeLocked()
		return fmt.Errorf("assign process to job object: %w", err)
	}
	if t.terminated {
		return t.terminateLocked()
	}
	return nil
}

// Terminate ends every process in the job.
//
// Safe to call after the child has been reaped: the job is identified by a
// handle we hold, not by a PID that could have been recycled.
func (t *Tree) Terminate() error {
	t.treeMu.Lock()
	defer t.treeMu.Unlock()

	t.terminated = true
	return t.terminateLocked()
}

func (t *Tree) terminateLocked() error {
	if t.job == 0 {
		// Job setup failed; let the caller fall back to killing the direct child.
		return ErrUnavailable
	}
	return windows.TerminateJobObject(t.job, 1)
}

// Close releases the job handle. Under KillOnClose that also kills anything
// still running in the job, so such a caller must not close before the output
// pipes have been drained.
func (t *Tree) Close() {
	t.treeMu.Lock()
	defer t.treeMu.Unlock()

	t.closeLocked()
}

func (t *Tree) closeLocked() {
	if t.job != 0 {
		windows.CloseHandle(t.job)
		t.job = 0
	}
}
