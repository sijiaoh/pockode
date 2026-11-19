package restart

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/pockode/server/internal/netutil"
)

const (
	// helperStartPortEnv is the port helperKeepsPort is configured with: its
	// -port.
	helperStartPortEnv = "POCKODE_TEST_RESTART_START_PORT"

	portReportFirst  = "first-port.json"
	portReportSecond = "second-port.json"
	// portGoFile is the test's signal to the first generation that it may
	// restart: whatever the test meant to do to the ports in between is done.
	portGoFile = "go"

	portHelperTimeout = 10 * time.Second
)

// portReport is what one generation of helperKeepsPort saw of itself.
type portReport struct {
	Port int `json:"port"`
	// Inherited is whether PortEnvVar was still set after TakePort, for
	// whatever this run spawns to inherit.
	Inherited bool `json:"inherited"`
}

// runPortHelper starts the way the server does — TakePort, then
// netutil.ListenAvailable — reports the port it got, and, in the first
// generation, restarts once the test says so.
func runPortHelper() {
	dir := os.Getenv(helperReportDirEnv)
	configured, err := strconv.Atoi(os.Getenv(helperStartPortEnv))
	if err != nil {
		panic(err)
	}
	ln, err := netutil.ListenAvailable(TakePort(configured))
	if err != nil {
		panic(err)
	}
	port := netutil.ListenerPort(ln)
	_, inherited := os.LookupEnv(PortEnvVar)
	report := portReport{Port: port, Inherited: inherited}

	if _, err := os.Stat(filepath.Join(dir, portReportFirst)); err == nil {
		writePortReport(filepath.Join(dir, portReportSecond), report)
		return
	}

	program, err := Current()
	if err != nil {
		panic(err)
	}
	r := New(program)
	r.KeepPort(port)
	if err := r.Request(context.Background()); err != nil {
		panic(err)
	}
	// As the shutdown does, before the port is reported: the test may want
	// to take it.
	ln.Close()
	writePortReport(filepath.Join(dir, portReportFirst), report)
	deadline := time.Now().Add(portHelperTimeout)
	for {
		if _, err := os.Stat(filepath.Join(dir, portGoFile)); err == nil {
			break
		}
		if time.Now().After(deadline) {
			panic("the test never said to restart")
		}
		time.Sleep(20 * time.Millisecond)
	}
	r.Restart("the-password")
}

// writePortReport writes through a rename, so a reader polling for the file
// never sees it half written.
func writePortReport(path string, report portReport) {
	data, err := json.Marshal(report)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(path+".tmp", data, 0600); err != nil {
		panic(err)
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		panic(err)
	}
}

// portHelper is a running helperKeepsPort.
type portHelper struct {
	t   *testing.T
	dir string
}

func startPortHelper(t *testing.T, configured int) portHelper {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(),
		helperEnv+"="+helperKeepsPort,
		helperReportDirEnv+"="+dir,
		helperStartPortEnv+"="+strconv.Itoa(configured),
	)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	t.Cleanup(func() {
		// Releases the helper if the test failed before it said go.
		os.WriteFile(filepath.Join(dir, portGoFile), nil, 0600)
		cmd.Wait()
	})
	return portHelper{t: t, dir: dir}
}

func (h portHelper) wait(name string) portReport {
	h.t.Helper()
	path := filepath.Join(h.dir, name)
	deadline := time.Now().Add(portHelperTimeout)
	for {
		data, err := os.ReadFile(path)
		if err == nil {
			var r portReport
			if err := json.Unmarshal(data, &r); err != nil {
				h.t.Fatalf("parse %s: %v", path, err)
			}
			return r
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("the helper never wrote %s", name)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// restart lets the first generation restart and returns what the second saw.
func (h portHelper) restart() portReport {
	h.t.Helper()
	if err := os.WriteFile(filepath.Join(h.dir, portGoFile), nil, 0600); err != nil {
		h.t.Fatal(err)
	}
	second := h.wait(portReportSecond)
	if second.Inherited {
		h.t.Errorf("%s was left set after TakePort, for children to inherit", PortEnvVar)
	}
	return second
}

func occupy(t *testing.T, port int) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		t.Fatalf("occupy port %d: %v", port, err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln
}

// TestRestart_KeepsPort is a restart in real processes, each starting the way
// the server does.
func TestRestart_KeepsPort(t *testing.T) {
	t.Run("comes back on the port it was listening on", func(t *testing.T) {
		const configured = 19900
		// Taken so the first run falls forward past it, then released before
		// the restart: a restart that searched from -port again would land on
		// it.
		taken := occupy(t, configured)
		h := startPortHelper(t, configured)
		first := h.wait(portReportFirst)
		if first.Port == configured {
			t.Fatalf("the first run listened on %d, which the test held", configured)
		}
		taken.Close()

		if second := h.restart(); second.Port != first.Port {
			t.Errorf("restarted on port %d, want %d, the one it was listening on", second.Port, first.Port)
		}
	})

	t.Run("falls forward when its port was taken meanwhile", func(t *testing.T) {
		const configured = 19910
		// As above, so that falling forward from its own port and searching
		// from -port again do not end on the same one.
		taken := occupy(t, configured)
		h := startPortHelper(t, configured)
		first := h.wait(portReportFirst)
		if first.Port == configured {
			t.Fatalf("the first run listened on %d, which the test held", configured)
		}
		taken.Close()
		occupy(t, first.Port)

		if second := h.restart(); second.Port != first.Port+1 {
			t.Errorf("restarted on port %d, want %d, the next one after its own", second.Port, first.Port+1)
		}
	})
}

func TestTakePort(t *testing.T) {
	const configured = 9870
	tests := []struct {
		name  string
		value *string
		want  int
	}{
		{"not a restart", nil, configured},
		{"the port a restart kept", ptr("9873"), 9873},
		{"not a number", ptr("x"), configured},
		{"out of range", ptr("65536"), configured},
		{"zero", ptr("0"), configured},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.value != nil {
				t.Setenv(PortEnvVar, *tc.value)
			}
			if got := TakePort(configured); got != tc.want {
				t.Errorf("TakePort(%d) = %d, want %d", configured, got, tc.want)
			}
			if _, ok := os.LookupEnv(PortEnvVar); ok {
				t.Errorf("%s is still set", PortEnvVar)
			}
		})
	}
}

func ptr(s string) *string { return &s }
