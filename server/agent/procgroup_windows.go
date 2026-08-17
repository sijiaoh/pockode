//go:build windows

package agent

import (
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// errNoJobObject reports that job setup failed, so the caller must fall back to
// killing the direct child on its own.
var errNoJobObject = errors.New("job object unavailable")

// processGroup tracks an AI CLI and its descendants through a Job Object.
//
// Windows has no process-group signalling comparable to Unix, and the tree is
// deeper here than it looks: npm installs `claude` as `claude.cmd`, so the
// direct child is a cmd.exe wrapper and the actual node process is a grandchild.
// A Job Object is the only mechanism that covers the whole tree — a process
// created by a job member automatically joins the job, and TerminateJobObject
// ends every member at once.
type processGroup struct {
	job windows.Handle
}

// newProcessGroup creates the job the child will be assigned to. Must be called
// before cmd.Start.
//
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is what makes this safe against our own
// crash: the handle is released when the server process dies, and the OS then
// tears the tree down for us instead of leaving orphans holding worktree files.
//
// CREATE_NEW_PROCESS_GROUP mirrors the Unix side, keeping a console Ctrl+C from
// reaching the CLI before the server can shut its sessions down in order.
//
// CREATE_NO_WINDOW keeps the CLI's console off the screen. It matters most
// where the server has no console of its own — a node started by a cluster, a
// service, Task Scheduler — because Windows allocates a *visible* console for
// the first console program such a process starts, and every AI CLI call would
// flash a black window at whoever is using the machine. Where the server does
// have a console the flag costs nothing that was being used: all three of the
// CLI's streams are pipes, so nothing it writes was going to reach a console
// either way.
//
// Windows ignores CREATE_NO_WINDOW when it is combined with CREATE_NEW_CONSOLE
// or DETACHED_PROCESS, so the CLI must not be handed either of those as a way of
// keeping it off ours — the flag beside it here is not one of them.
func newProcessGroup(cmd *exec.Cmd) *processGroup {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW

	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		slog.Error("failed to create job object for AI CLI", "error", err)
		return &processGroup{}
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if err := setJobLimits(job, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		slog.Error("failed to configure job object for AI CLI", "error", err)
		windows.CloseHandle(job)
		return &processGroup{}
	}

	return &processGroup{job: job}
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

// adopt puts the started child into the job.
//
// Windows offers no way to hand a job to CreateProcess through os/exec, so this
// necessarily happens just after the process exists. The child could in theory
// spawn a descendant in that window and leave it outside the job, but it has
// barely begun executing at this point, so the window is far shorter than any
// process startup.
//
// On failure the job is dropped rather than kept. An empty job is worse than no
// job: TerminateJobObject would report success on it, and the CLI it was meant
// to cover would keep running unnoticed. Releasing it makes terminate report
// that it has nothing to work with, so the caller falls back to the direct child.
func (g *processGroup) adopt(cmd *exec.Cmd) error {
	if g.job == 0 {
		return nil // Creation already failed and was reported.
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		g.close()
		return fmt.Errorf("open process: %w", err)
	}
	defer windows.CloseHandle(handle)

	if err := windows.AssignProcessToJobObject(g.job, handle); err != nil {
		g.close()
		return fmt.Errorf("assign process to job object: %w", err)
	}
	return nil
}

// terminate ends every process in the job.
//
// Safe to call after the child has been reaped: the job is identified by a
// handle we hold, not by a PID that could have been recycled.
func (g *processGroup) terminate() error {
	if g.job == 0 {
		// Job setup failed; let the caller fall back to killing the direct child.
		return errNoJobObject
	}
	return windows.TerminateJobObject(g.job, 1)
}

// close releases the job handle. Because of KILL_ON_JOB_CLOSE this also kills
// anything still running in it, so it must come after the output pipes have
// been drained.
func (g *processGroup) close() {
	if g.job != 0 {
		windows.CloseHandle(g.job)
		g.job = 0
	}
}
