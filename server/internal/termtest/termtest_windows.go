//go:build windows

package termtest

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetConsoleProcessList = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleProcessList")

// errNoConsole reports the one failure that is an answer rather than a problem.
var errNoConsole = errors.New("this process has no console")

// Of reports whether this process is attached to the console of the process
// that started it.
//
// The probe is GetConsoleProcessList rather than GetConsoleWindow because the
// question is membership, not visibility, and the two do not coincide: a console
// can have no window at all — that is what a service's console looks like, and
// what CREATE_NO_WINDOW asks for — so "no window" would report a process sitting
// squarely on ours as detached from it.
//
// It reads the parent PID from the OS, which is only meaningful while the parent
// is still alive: Windows records the PID rather than a reference to it, and a
// dead parent's PID can be reused by an unrelated process. Every caller here is
// a child whose parent is waiting on it.
func Of() Attachment {
	pids, err := consoleProcesses()
	switch {
	case errors.Is(err, errNoConsole):
		// Which is exactly what DETACHED_PROCESS produces.
		return Detached
	case err != nil:
		// Not an answer: saying "detached" here would turn a broken probe into a
		// passing test.
		return Attachment("cannot read the console process list: " + err.Error())
	}

	ppid := os.Getppid()
	if ppid <= 0 {
		return Attachment(fmt.Sprintf("cannot identify the parent process (Getppid returned %d)", ppid))
	}
	for _, pid := range pids {
		if pid == uint32(ppid) {
			return SharesParent
		}
	}
	return Detached
}

// HasTerminal reports whether this process has a console of its own to hand
// down. A process running as a service, under Task Scheduler, or on a CI runner
// may have none, and then a child could not have inherited one either — which
// makes "the child is detached" true for a reason that has nothing to do with
// how it was started.
func HasTerminal() bool {
	_, err := consoleProcesses()
	return err == nil
}

// consoleProcesses returns the PIDs sharing this process's console, or
// errNoConsole if it has none.
func consoleProcesses() ([]uint32, error) {
	// GetConsoleProcessList always answers with the number of processes on the
	// console, and fills the buffer only when it is large enough, so a short
	// buffer costs one more call rather than a wrong answer. Zero means the call
	// failed, and with a valid buffer the only way that happens is having no
	// console.
	//
	// The retries are bounded because the count comes from live state: a process
	// joining the console between one call and the next grows the answer again,
	// and a loop that trusted it to settle would be a loop with no reason to end.
	// A console this is asked about holds a handful.
	const maxAttempts = 3

	pids := make([]uint32, 8)
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		n, _, err := syscall.SyscallN(procGetConsoleProcessList.Addr(), uintptr(unsafe.Pointer(&pids[0])), uintptr(len(pids)))
		if n == 0 {
			return nil, fmt.Errorf("%w (GetConsoleProcessList: %v)", errNoConsole, err)
		}
		if int(n) <= len(pids) {
			return pids[:n], nil
		}
		pids = make([]uint32, n)
	}
	return nil, fmt.Errorf("the console outgrew the buffer %d times running, last size %d", maxAttempts, len(pids))
}
