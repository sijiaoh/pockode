package agent

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRunStream(t *testing.T) {
	// The prompt goes in on stdin and is several lines long, which the command
	// line could not carry through the Windows .cmd wrapper at all.
	t.Run("hands the input over on stdin and each output line to onLine", func(t *testing.T) {
		t.Setenv(roleEnv, roleEcho)
		var lines []string
		stop := errors.New("seen enough")
		_, err := RunStream(context.Background(), slog.Default(), os.Args[0], "", nil, "first\nsecond\n", func(line []byte) error {
			lines = append(lines, string(line))
			if len(lines) == 2 {
				return stop
			}
			return nil
		})
		if !errors.Is(err, stop) {
			t.Fatalf("got %v, want onLine's error", err)
		}
		if strings.Join(lines, "|") != "first|second" {
			t.Errorf("lines = %q", lines)
		}
	})

	// A tool call has to stop the CLI then and there: waiting for it to finish
	// would let the call run.
	t.Run("an error from onLine kills the CLI rather than waiting for it", func(t *testing.T) {
		t.Setenv(roleEnv, roleEcho)
		start := time.Now()
		_, err := RunStream(context.Background(), slog.Default(), os.Args[0], "", nil, "tool call\n", func([]byte) error {
			return ErrOneShotToolUse
		})
		if !errors.Is(err, ErrOneShotToolUse) {
			t.Fatalf("got %v, want ErrOneShotToolUse", err)
		}
		if elapsed := time.Since(start); elapsed > leafLifetime/2 {
			t.Errorf("RunStream took %s, so the CLI was waited out rather than killed", elapsed)
		}
	})

	t.Run("gives up when ctx is done", func(t *testing.T) {
		t.Setenv(roleEnv, roleEcho)
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		_, err := RunStream(ctx, slog.Default(), os.Args[0], "", nil, "", func([]byte) error { return nil })
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("got %v, want the deadline", err)
		}
	})

	t.Run("a non-zero exit is a result carrying stderr", func(t *testing.T) {
		t.Setenv(roleEnv, roleFail)
		res, err := RunStream(context.Background(), slog.Default(), os.Args[0], "", nil, "", func([]byte) error { return nil })
		if err != nil {
			t.Fatalf("RunStream: %v", err)
		}
		if res.ExitCode != 3 || res.Stderr != "Logout failed: no network\n" {
			t.Errorf("got %+v", res)
		}
	})
}

// Only the tail of stderr is kept: the CLI's account of why it failed is at
// the end, and a chatty CLI must not be held in memory whole.
func TestTailBuffer(t *testing.T) {
	tail := tailBuffer{max: 8}
	for _, chunk := range []string{"0123", "456789", "abc"} {
		if _, err := tail.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	if got := string(tail.buf); got != "56789abc" {
		t.Errorf("tail = %q, want %q", got, "56789abc")
	}
}
