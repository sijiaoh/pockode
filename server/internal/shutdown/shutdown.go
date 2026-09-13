// Package shutdown carries the request to end a pockode process: how a process
// learns that it should exit, and how another process asks it to.
//
// The two live together because on Windows they are two halves of one protocol
// — the waiter and the signaller have to agree on the name of a kernel event —
// and splitting them would leave that name written down twice.
package shutdown

import (
	"os"
	"os/signal"
	"sync"
	"syscall"
)

// Listener reports the first request to shut the current process down.
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
	return l
}

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
	})
}

func (l *Listener) requested() {
	l.doneOnce.Do(func() { close(l.done) })
}
