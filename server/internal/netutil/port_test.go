package netutil

import (
	"net"
	"sync"
	"testing"
)

func listenAvailable(t *testing.T, startPort int) net.Listener {
	t.Helper()
	ln, err := ListenAvailable(startPort)
	if err != nil {
		t.Fatalf("ListenAvailable(%d): %v", startPort, err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln
}

func TestListenAvailable(t *testing.T) {
	t.Run("listens on the requested port when it is free", func(t *testing.T) {
		ln := listenAvailable(t, 19870)
		if got := ListenerPort(ln); got != 19870 {
			t.Errorf("got port %d, want 19870", got)
		}
	})

	t.Run("falls forward to the next free port", func(t *testing.T) {
		occupied, err := net.Listen("tcp", ":19871")
		if err != nil {
			t.Fatalf("failed to occupy port: %v", err)
		}
		defer occupied.Close()

		ln := listenAvailable(t, 19871)
		if got := ListenerPort(ln); got != 19872 {
			t.Errorf("got port %d, want 19872", got)
		}
	})

	// The race this function exists to close: every caller is still holding
	// its listener when the next one chooses, as servers starting together are.
	t.Run("concurrent callers get distinct ports", func(t *testing.T) {
		const callers = 8
		listeners := make([]net.Listener, callers)
		errs := make([]error, callers)
		var wg sync.WaitGroup
		for i := range callers {
			wg.Go(func() {
				listeners[i], errs[i] = ListenAvailable(19880)
			})
		}
		wg.Wait()

		seen := make(map[int]bool)
		for i := range callers {
			if errs[i] != nil {
				t.Errorf("caller %d: %v", i, errs[i])
				continue
			}
			defer listeners[i].Close()
			port := ListenerPort(listeners[i])
			if seen[port] {
				t.Errorf("port %d was handed out twice", port)
			}
			seen[port] = true
		}
	})

	t.Run("rejects a start port outside the TCP range", func(t *testing.T) {
		for _, port := range []int{-1, 65536} {
			if ln, err := ListenAvailable(port); err == nil {
				ln.Close()
				t.Errorf("ListenAvailable(%d): expected an error, got port %d", port, ListenerPort(ln))
			}
		}
	})

	t.Run("reports the bind error when every port in range is taken", func(t *testing.T) {
		// Failing to occupy it means something else already holds it, which
		// is the condition under test all the same.
		if occupied, err := net.Listen("tcp", ":65535"); err == nil {
			defer occupied.Close()
		}

		if ln, err := ListenAvailable(65535); err == nil {
			ln.Close()
			t.Fatal("expected an error when the only port in range is taken")
		}
	})
}
