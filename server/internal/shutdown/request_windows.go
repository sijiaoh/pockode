//go:build windows

package shutdown

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"

	"golang.org/x/sys/windows"
)

// eventName is the kernel event a pockode process waits on to be asked to exit.
//
// The name lives in the session-local namespace, which is exactly the reach
// needed: a cluster only ever stops nodes it started itself, so both sides are
// always in the same session, while no other session can reach in.
func eventName(pid int) string {
	return `Local\pockode-shutdown-` + strconv.Itoa(pid)
}

// RequestExit asks the process with the given PID to shut down gracefully.
//
// Windows has no SIGTERM. Its documented stand-in, a Ctrl+Break console event,
// only reaches processes that share the *caller's* console — so it does nothing
// for a cluster running as a service, from Task Scheduler, or otherwise
// detached, which is how an always-on machine is most likely to run one. A
// named event has no such requirement and is therefore the primary channel.
//
// The console event survives as a fallback for one case: a node started by a
// build that predates the event, still running while the cluster is upgraded
// and restarted around it. Such a node was started attached to the console of
// the cluster that spawned it, which is why the fallback can still reach it —
// and only if the new cluster shares that console. It cannot reach a node this
// build starts, because those are launched with no console at all, and it does
// not need to: they all publish the event.
//
// The PID is rejected unless it is positive: it reaches us from server.json, and
// GenerateConsoleCtrlEvent reads 0 as "every process sharing my console" — a
// corrupted file must not be able to turn a request to stop one node into a
// Ctrl+Break for the cluster itself and everything else on its console.
func RequestExit(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("cannot ask process %d to exit: pid must be positive", pid)
	}

	name, err := windows.UTF16PtrFromString(eventName(pid))
	if err != nil {
		return err
	}

	handle, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, name)
	if err != nil {
		if ctrlErr := windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(pid)); ctrlErr != nil {
			return fmt.Errorf("open shutdown event: %w (console ctrl event: %v)", err, ctrlErr)
		}
		return nil
	}
	defer windows.CloseHandle(handle)

	return windows.SetEvent(handle)
}

// requestWatcher waits for the event RequestExit signals.
type requestWatcher struct {
	event windows.Handle
	quit  windows.Handle
	done  chan struct{}
}

// watchExitRequests publishes this process's shutdown event and calls notify
// once it is signalled. It returns nil if the event cannot be published, which
// leaves console signalling as the only way in — and a node started by a
// cluster has no console, so for one of those the cluster's request degrades all
// the way to a forced kill. Still better than refusing to start: the process
// runs, it only loses the graceful path.
func watchExitRequests(notify func()) *requestWatcher {
	name, err := windows.UTF16PtrFromString(eventName(os.Getpid()))
	if err != nil {
		slog.Error("failed to build shutdown event name", "error", err)
		return nil
	}

	// Manual reset: a shutdown request is not something to consume, it stays
	// true once made.
	event, err := windows.CreateEvent(nil, 1, 0, name)
	if err != nil {
		// CreateEvent reports ERROR_ALREADY_EXISTS through err while still
		// handing back a usable handle to whatever object already had the name.
		// Our own PID should be ours alone, so treat that as a name we do not
		// own rather than adopting it — and close the handle either way, since
		// bailing out with one open would leak it.
		if event != 0 {
			windows.CloseHandle(event)
		}
		slog.Error("failed to publish shutdown event", "name", eventName(os.Getpid()), "error", err)
		return nil
	}

	quit, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(event)
		slog.Error("failed to create shutdown watcher quit event", "error", err)
		return nil
	}

	w := &requestWatcher{event: event, quit: quit, done: make(chan struct{})}
	go func() {
		// This blocks an OS thread for the life of the process, the same cost as
		// the goroutine parked on the signal channel next to it.
		defer close(w.done)
		result, err := windows.WaitForMultipleObjects([]windows.Handle{w.event, w.quit}, false, windows.INFINITE)
		if err != nil {
			slog.Error("shutdown event wait failed", "error", err)
			return
		}
		if result == windows.WAIT_OBJECT_0 {
			notify()
		}
	}()
	return w
}

func (w *requestWatcher) stop() {
	if w == nil {
		return
	}
	if err := windows.SetEvent(w.quit); err != nil {
		// The waiting goroutine still owns both handles, and closing them out
		// from under an in-flight wait is worse than leaking them.
		slog.Error("failed to stop shutdown watcher", "error", err)
		return
	}
	<-w.done
	windows.CloseHandle(w.event)
	windows.CloseHandle(w.quit)
}
