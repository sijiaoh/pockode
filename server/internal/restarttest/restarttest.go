// Package restarttest stands the test binary in for the pockode executable on
// disk, so that a package's tests can read an installed version, or fail to,
// through restart.Program as the server does — by running a file.
//
// The test binary is the file: a package calls Main from its TestMain, and a
// run of it with --version answers as Install or Break last said. Each test
// says it with t.Setenv, which the run inherits.
package restarttest

import (
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/internal/restart"
)

// installedEnv carries what the next --version run answers: "version:<v>" or
// "fails:<stderr>".
const installedEnv = "POCKODE_TEST_INSTALLED"

// Main runs the package's tests, unless this run of the binary is one of the
// --version runs Executable stands for.
func Main(m *testing.M) {
	if answer, ok := os.LookupEnv(installedEnv); ok && slices.Contains(os.Args[1:], "--version") {
		if msg, failing := strings.CutPrefix(answer, "fails:"); failing {
			fmt.Fprintln(os.Stderr, msg)
			os.Exit(3)
		}
		fmt.Println("pockode " + strings.TrimPrefix(answer, "version:"))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// Executable is the program the test binary stands in for, started in dir.
func Executable(dir string) restart.Program {
	return restart.Program{Path: os.Args[0], Dir: dir}
}

// Install makes Executable report version for the rest of t.
func Install(t *testing.T, version string) {
	t.Setenv(installedEnv, "version:"+version)
}

// Break makes Executable fail to run for the rest of t, printing stderr.
func Break(t *testing.T, stderr string) {
	t.Setenv(installedEnv, "fails:"+stderr)
}
