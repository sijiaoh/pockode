package netutil

import (
	"net"
	"testing"
)

func TestFindAvailablePort(t *testing.T) {
	t.Run("returns requested port when available", func(t *testing.T) {
		port := FindAvailablePort(19870)
		if port != 19870 {
			t.Errorf("got port %d, want 19870", port)
		}
	})

	t.Run("increments when port is occupied", func(t *testing.T) {
		ln, err := net.Listen("tcp", ":19871")
		if err != nil {
			t.Fatalf("failed to occupy port: %v", err)
		}
		defer ln.Close()

		port := FindAvailablePort(19871)
		if port != 19872 {
			t.Errorf("got port %d, want 19872", port)
		}
	})
}
