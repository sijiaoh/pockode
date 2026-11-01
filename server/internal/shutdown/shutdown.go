// Package shutdown carries the request to end a pockode process: how a process
// learns that it should exit — or restart — and how another process asks it to.
//
// The two live together because on Windows they are two halves of one protocol
// — the waiter and the signaller have to agree on the name of a kernel event —
// and splitting them would leave that name written down twice.
package shutdown

import (
	"errors"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

// Listener reports the first request to shut the current process down, and
// every request to restart it.
//
// Every platform delivers SIGINT and SIGTERM. Windows has no SIGTERM to send,
// so it also carries an out-of-band channel that RequestExit uses; see
// request_windows.go.
type Listener struct {
	done     chan struct{}
	doneOnce sync.Once

	signals  chan os.Signal
	watcher  *requestWatcher
	stopOnce sync.Once

	restarts chan struct{}
}

// Listen starts reporting exit requests. Call Stop when the shutdown is
// underway: it restores the default handling, so a second Ctrl+C aborts a
// shutdown that is taking too long instead of being swallowed.
func Listen() *Listener {
	l := &Listener{
		done:    make(chan struct{}),
		signals: make(chan os.Signal, 1),
	}

	signal.Notify(l.signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		if _, ok := <-l.signals; ok {
			l.requested()
		}
	}()

	l.watcher = watchExitRequests(l.requested)

	l.restarts = make(chan struct{}, 1)
	restartRequests.attach(l.restarts)
	return l
}

// Restarts delivers a value for every restart request — RequestRestart from
// another process, or `kill -USR1` on unix — coalescing those that arrive
// before the previous one was taken. A request that arrived before the first
// Listen, while HoldRestartRequests was holding it, is delivered at once. It is
// closed by Stop. Whether the process actually restarts is not decided here: see
// internal/restart.
func (l *Listener) Restarts() <-chan struct{} { return l.restarts }

// Done is closed once the process has been asked to exit.
func (l *Listener) Done() <-chan struct{} { return l.done }

// Stop releases the listener. Done stays closed if it already was.
func (l *Listener) Stop() {
	l.stopOnce.Do(func() {
		// Stop before close: signal.Stop guarantees no further sends, which is
		// what makes closing the channel safe.
		signal.Stop(l.signals)
		close(l.signals)
		l.watcher.stop()
		// The restart signal keeps its handler: requests arriving from now on
		// are dropped rather than handed back to the default action, which for
		// SIGUSR1 is to terminate and would cut the shutdown short.
		restartRequests.detach(l.restarts)
	})
}

func (l *Listener) requested() {
	l.doneOnce.Do(func() { close(l.done) })
}

// HoldInterrupts keeps Ctrl+C (and, on Windows, Ctrl+Break) from ending the
// process for the rest of its life.
//
// It is not a way to listen for exit requests — Listen is — and is meant for a
// process that has already shut down but must not return yet: on Windows a
// restart from a terminal waits on its successor, and Ctrl+C reaches every
// process on the console, so without this one meant for the successor would
// hand the prompt back while the successor goes on running.
func HoldInterrupts() {
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	go func() {
		for range interrupts {
		}
	}()
}

// HoldRestartRequests starts receiving restart requests for the rest of the
// process's life. Call it first thing in a process that restarts itself.
//
// Until something receives it, SIGUSR1 has its default action, which is to
// terminate — and Listen comes late in startup, after the relay is up. Without
// this, a request sent while the process is starting — a second one sent while
// a restarted process comes back up, say — would kill it. Held requests are
// delivered by the first Listen. What remains is the moment between exec and
// this call (runtime start-up and flag parsing), when the signal is back at
// its default: nothing the process can do covers it.
//
// The signal is caught, never ignored: an ignored signal stays ignored in
// every child, and the AI CLIs are Node programs, for which SIGUSR1 means
// something. A caught one is reset to the default in each child.
//
// On Windows this is also the moment the process publishes the named event
// RequestRestart signals, so from here on it can be asked to restart.
//
// Listen calls it too, so a process that never calls it is no worse off than
// before.
func HoldRestartRequests() { restartRequests.hold() }

// ErrRestartUnsupported reports that the process cannot be asked to restart
// from outside: nothing is waiting for the request — on Windows, no restart
// event is published under its PID, which is what a pockode build that predates
// restarts looks like. Only Windows can tell; on unix the signal is sent
// regardless, and what an old build does with it is to terminate, so a caller
// has to know the process is new enough before it asks (the version in its
// server.json).
var ErrRestartUnsupported = errors.New("process does not accept restart requests")

// restartRequests routes the process's restart requests to the Listener in
// charge, if any. It is process-wide because what it listens on is: a signal
// disposition on unix, an event named after the PID on Windows.
var restartRequests restartRouter

type restartRouter struct {
	holdOnce sync.Once

	routeMu  sync.Mutex
	target   chan struct{} // the current Listener's Restarts, nil when none
	listened bool          // a Listener has attached at least once
	held     bool          // a request arrived before the first Listener
}

func (r *restartRouter) hold() {
	r.holdOnce.Do(func() { watchRestartRequests(r.deliver) })
}

func (r *restartRouter) deliver() {
	r.routeMu.Lock()
	defer r.routeMu.Unlock()
	switch {
	case r.target != nil:
		// A request already waiting says everything a second one would.
		select {
		case r.target <- struct{}{}:
		default:
		}
	case !r.listened:
		r.held = true
	}
	// Otherwise the process is shutting down, and there is nothing left for a
	// restart request to act on.
}

func (r *restartRouter) attach(target chan struct{}) {
	r.hold()
	r.routeMu.Lock()
	defer r.routeMu.Unlock()
	r.target = target
	r.listened = true
	if r.held {
		r.held = false
		target <- struct{}{}
	}
}

// detach closes target, which no request reaches from then on.
func (r *restartRouter) detach(target chan struct{}) {
	r.routeMu.Lock()
	defer r.routeMu.Unlock()
	if r.target == target {
		r.target = nil
	}
	close(target)
}
