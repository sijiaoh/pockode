package netutil

import (
	"fmt"
	"net"
)

const (
	maxPortAttempts = 100
	maxPort         = 65535
)

// ListenAvailable listens on the first port from startPort upward that it can
// bind, trying up to maxPortAttempts consecutive ports, and returns that
// listener for the caller to serve on.
//
// The listener itself is the result, not its port number: a port that is
// probed and released is free for anyone until it is bound again, so
// processes starting together would all pick the same one and all but the
// first would fail to bind it. Holding the listener makes the kernel the
// arbiter — each concurrent caller gets a port of its own.
//
// Every bind error falls forward, not just "address in use": on Windows a
// port inside a reserved range is refused as access denied, and the next one
// may well be free.
func ListenAvailable(startPort int) (net.Listener, error) {
	// Checked up front rather than left to Listen: falling forward from a
	// negative port would reach ":0" and silently bind a random one.
	if startPort < 0 || startPort > maxPort {
		return nil, fmt.Errorf("port %d is not a valid TCP port (0-%d)", startPort, maxPort)
	}
	lastPort := min(startPort+maxPortAttempts-1, maxPort)
	var lastErr error
	for port := startPort; port <= lastPort; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err == nil {
			return ln, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("no port available in %d-%d: %w", startPort, lastPort, lastErr)
}

// ListenerPort returns the TCP port ln is bound to.
func ListenerPort(ln net.Listener) int {
	return ln.Addr().(*net.TCPAddr).Port
}
