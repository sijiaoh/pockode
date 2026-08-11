package startup

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
)

func found(name string) agent.BinaryStatus {
	return agent.BinaryStatus{Name: name}
}

func missing(name string) agent.BinaryStatus {
	return agent.BinaryStatus{Name: name, Err: errors.New("not found")}
}

// noColor keeps the assertions on the text itself. colorsEnabled() is already
// false under `go test` (stdout is a pipe, not a terminal), but pinning it
// makes that independent of how the tests are run.
func noColor(t *testing.T) {
	t.Helper()
	prev := noColorSet
	noColorSet = true
	t.Cleanup(func() { noColorSet = prev })
}

func TestAgentLines(t *testing.T) {
	tests := []struct {
		name    string
		agents  []agent.BinaryStatus
		want    []string
		notWant []string
	}{
		{
			name:   "nothing to report stays off the banner",
			agents: nil,
		},
		{
			// Every start prints this, so all-well has to be skimmable: one
			// line, no advice, nothing that reads as a problem.
			name:   "all found is one quiet line",
			agents: []agent.BinaryStatus{found("claude"), found("codex")},
			want:   []string{"▸ Agents claude  codex"},
		},
		{
			name:    "one missing is noted without a warning",
			agents:  []agent.BinaryStatus{found("claude"), missing("codex")},
			want:    []string{"▸ Agents claude  codex (not found)"},
			notWant: []string{"⚠"},
		},
		{
			// No CLI at all means no session can run, which is worth the noise.
			name:   "none found warns and says what to do",
			agents: []agent.BinaryStatus{missing("claude"), missing("codex")},
			want: []string{
				"▸ Agents claude (not found)  codex (not found)",
				"⚠ No AI CLI found — sessions cannot start",
				"Install claude or codex, then restart pockode",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			noColor(t)
			out := strings.Join(agentLines(tt.agents), "\n")
			if tt.agents == nil {
				if out != "" {
					t.Fatalf("expected no output, got:\n%s", out)
				}
				return
			}
			for _, want := range tt.want {
				if !strings.Contains(out, want) {
					t.Errorf("missing %q in:\n%s", want, out)
				}
			}
			for _, notWant := range tt.notWant {
				if strings.Contains(out, notWant) {
					t.Errorf("unexpected %q in:\n%s", notWant, out)
				}
			}
		})
	}
}

// TestPrintBannerShowsAgents pins the wiring rather than the wording: the
// section is worth nothing if it never reaches the banner the user reads, and
// that is the one part the pure-function tests above cannot see.
func TestPrintBannerShowsAgents(t *testing.T) {
	// PrintBanner writes NoColor into package state and leaves it there, so
	// this restores it rather than deciding the color of every later test.
	noColor(t)

	out := captureStdout(t, func() {
		PrintBanner(BannerOptions{
			Version:  "test",
			LocalURL: "http://localhost:9870",
			Agents:   []agent.BinaryStatus{found("claude"), missing("codex")},
			NoColor:  true,
		})
	})

	if !strings.Contains(out, "▸ Agents claude  codex (not found)") {
		t.Errorf("the banner does not carry the agent section:\n%s", out)
	}
	// Its neighbours have to survive it.
	for _, want := range []string{"P O C K O D E", "▸ Local  http://localhost:9870"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stdout
	os.Stdout = w
	// Closing here too, so a panicking fn does not strand the reader goroutine
	// on a pipe that never ends. The second Close is a no-op error we ignore.
	defer func() {
		os.Stdout = prev
		_ = w.Close()
	}()

	done := make(chan string, 1)
	go func() {
		defer r.Close()
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, r)
		done <- buf.String()
	}()

	fn()
	w.Close()
	return <-done
}

// The warning is what a user acts on, so it has to survive a terminal that
// drops the color it is carried by.
func TestAgentLinesWarnsWithoutColor(t *testing.T) {
	noColor(t)
	got := agentLines([]agent.BinaryStatus{missing("claude")})
	if len(got) < 2 {
		t.Fatalf("expected the warning block, got %q", got)
	}
	if !strings.Contains(strings.Join(got, "\n"), "sessions cannot start") {
		t.Errorf("the warning does not survive without color:\n%s", strings.Join(got, "\n"))
	}
}
