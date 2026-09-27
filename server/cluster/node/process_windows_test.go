//go:build windows

package node

import (
	"os"
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/pockode/server/internal/termtest"
)

// helperSpawns stands in for a node running a command: it starts a child the
// way an unflagged exec.Command in the node would, then reports on both the
// child and its own console.
const helperSpawns = "spawns"

// Suffixes on the ready path for the two reports helperSpawns writes.
const (
	spawnedReportSuffix = ".spawned"
	windowReportSuffix  = ".window"
)

// What helperSpawns reports about its own console window.
const (
	consoleWindowNone    = "no console window"
	consoleWindowHidden  = "console window hidden"
	consoleWindowVisible = "console window visible"
)

var procGetConsoleWindow = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow")

func init() {
	platformHelperModes[helperSpawns] = func() {
		ready := os.Getenv(helperReadyEnv)

		cmd := exec.Command(os.Args[0])
		cmd.Env = append(os.Environ(), helperEnv+"="+helperReports, helperReadyEnv+"="+ready+spawnedReportSuffix)
		if err := cmd.Run(); err != nil {
			panic(err)
		}

		if err := os.WriteFile(ready+windowReportSuffix, []byte(consoleWindow()), 0600); err != nil {
			panic(err)
		}
	}
}

func consoleWindow() string {
	hwnd, _, _ := procGetConsoleWindow.Call()
	switch {
	case hwnd == 0:
		return consoleWindowNone
	case windows.IsWindowVisible(windows.HWND(hwnd)):
		return consoleWindowVisible
	default:
		return consoleWindowHidden
	}
}

// TestSetProcessDetached_NodeHandsItsChildrenAHiddenConsole is the regression
// test for the black windows a cluster-started node used to flash: a node with
// no console had Windows allocate a visible one for every console program it
// started — every git call, every hook — and nothing short of flagging each exec
// could stop it.
//
// A child that shares the node's console is a child Windows made no console
// for, and a node whose own console has no visible window has none to show. Both
// are observable here whether or not this test process has a console of its
// own, because the launch flags create the node's console rather than pass ours
// down.
func TestSetProcessDetached_NodeHandsItsChildrenAHiddenConsole(t *testing.T) {
	helper := startHelperNode(t, helperSpawns)

	select {
	case <-helper.exited:
	case <-time.After(30 * time.Second):
		t.Fatal("helper node did not exit after its child reported")
	}

	spawned, err := os.ReadFile(helper.report + spawnedReportSuffix)
	if err != nil {
		t.Fatalf("reading the spawned child's report: %v", err)
	}
	if got := termtest.Attachment(spawned); got != termtest.SharesParent {
		t.Errorf("a plain exec from the node reports %q, want %q: Windows gave it a console of its own", got, termtest.SharesParent)
	}

	window, err := os.ReadFile(helper.report + windowReportSuffix)
	if err != nil {
		t.Fatalf("reading the node's console report: %v", err)
	}
	if got := string(window); got == consoleWindowVisible {
		t.Errorf("node reports %q, want no window on screen", got)
	}
}
