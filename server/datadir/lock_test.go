package datadir

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// holderEnv makes a run of the test binary stand in for another server: it
// locks the directory the variable names, starts a child that outlives it
// (as an AI CLI may), prints the child's PID and holds the lock until killed.
const holderEnv = "POCKODE_TEST_DATADIR_HOLDER"

// childEnv makes a run of the test binary sleep until killed.
const childEnv = "POCKODE_TEST_DATADIR_CHILD"

func TestMain(m *testing.M) {
	if os.Getenv(childEnv) != "" {
		time.Sleep(time.Hour)
		os.Exit(0)
	}
	if dir := os.Getenv(holderEnv); dir != "" {
		unlock, err := Lock(dir)
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		child := exec.Command(os.Args[0])
		child.Env = append(os.Environ(), childEnv+"=1")
		if err := child.Start(); err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		fmt.Println("locked", child.Process.Pid)
		// Sleep rather than select {}: with no goroutine left that could wake
		// it, the runtime ends a bare select as a deadlock — and the lock with it.
		time.Sleep(time.Hour)
		// Never reached; keeps the lock's file reachable, so a GC cannot
		// finalize its handle and drop the lock mid-test.
		unlock()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// startHolder runs another process holding dir's lock and returns once it
// does.
func startHolder(t *testing.T, dir string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), holderEnv+"="+dir)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	var childPID int
	if _, scanErr := fmt.Sscanf(line, "locked %d", &childPID); scanErr != nil {
		t.Fatalf("holder did not take the lock: %q, %v", line, err)
	}
	child, err := os.FindProcess(childPID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { child.Kill() })
	return cmd
}

func TestLockRefusesASecondServer(t *testing.T) {
	dir := t.TempDir()
	startHolder(t, dir)

	_, err := lock(dir, 0)
	if !errors.Is(err, ErrInUse) {
		t.Fatalf("Lock while another process holds it: got %v, want ErrInUse", err)
	}
	if !strings.Contains(err.Error(), dir) {
		t.Errorf("error %q does not name the directory", err)
	}
}

// A server that crashed or was killed leaves no lock behind for the next one
// to trip over, even while a process it started is still running.
func TestLockIsFreeOnceItsHolderDies(t *testing.T) {
	dir := t.TempDir()
	holder := startHolder(t, dir)
	if err := holder.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	holder.Wait()

	unlock, err := Lock(dir)
	if err != nil {
		t.Fatalf("Lock after the holder was killed: %v", err)
	}
	unlock()
}

// Released on shutdown, the directory is free for whoever comes next — the
// run a restart replaces this one with included.
func TestLockIsFreeOnceReleased(t *testing.T) {
	dir := t.TempDir()
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatalf("Lock: %v", err)
	}
	if _, err := lock(dir, 0); !errors.Is(err, ErrInUse) {
		t.Fatalf("second Lock in the same process: got %v, want ErrInUse", err)
	}
	unlock()

	unlock, err = Lock(dir)
	if err != nil {
		t.Fatalf("Lock after release: %v", err)
	}
	unlock()
}

// Distinct data directories do not contend: two projects, or a project and a
// cluster node elsewhere, run side by side.
func TestLockIsPerDirectory(t *testing.T) {
	unlock, err := Lock(t.TempDir())
	if err != nil {
		t.Fatalf("Lock: %v", err)
	}
	defer unlock()
	other, err := Lock(t.TempDir())
	if err != nil {
		t.Fatalf("Lock on another directory: %v", err)
	}
	other()
}

// A holder that lets go while Lock is still waiting — a predecessor whose
// lock the OS has not dropped yet — is waited out rather than refused.
func TestLockWaitsOutAHolderThatLetsGo(t *testing.T) {
	dir := t.TempDir()
	held, err := Lock(dir)
	if err != nil {
		t.Fatalf("Lock: %v", err)
	}
	time.AfterFunc(2*lockRetryInterval, held)

	unlock, err := lock(dir, 10*time.Second)
	if err != nil {
		t.Fatalf("Lock while the holder lets go: %v", err)
	}
	unlock()
}
