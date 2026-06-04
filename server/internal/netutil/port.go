package netutil

import (
	"fmt"
	"net"
)

// FindAvailablePort finds an available TCP port starting from startPort.
// It tries up to 100 consecutive ports and returns the first available one.
// If no port is available, it returns startPort as a fallback.
func FindAvailablePort(startPort int) int {
	const maxAttempts = 100
	for port := startPort; port < startPort+maxAttempts; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err == nil {
			ln.Close()
			return port
		}
	}
	return startPort
}
