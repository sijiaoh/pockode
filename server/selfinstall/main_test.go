package selfinstall

import (
	"io"
	"os"
	"testing"

	"github.com/pockode/server/internal/restarttest"
)

// runningEnv makes a run of the test binary stand in for a running Pockode:
// it holds its own executable open, as every running program does, until
// its standard input closes.
const runningEnv = "POCKODE_TEST_SELFINSTALL_RUNNING"

// The test binary is the release a test installs: a copy of it, run with
// --version, answers what restarttest.Install last set.
func TestMain(m *testing.M) {
	if os.Getenv(runningEnv) != "" {
		io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
	restarttest.Main(m)
}
