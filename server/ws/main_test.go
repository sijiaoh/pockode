package ws

import (
	"testing"

	"github.com/pockode/server/internal/restarttest"
)

// TestMain lets the test binary stand in for the installed executable that
// server.version and server.restart run (see restarttest).
func TestMain(m *testing.M) {
	restarttest.Main(m)
}
