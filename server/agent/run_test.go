package agent

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"testing"
	"time"
)

func TestRun(t *testing.T) {
	t.Run("hands back what the CLI printed", func(t *testing.T) {
		t.Setenv(roleEnv, roleArgv)
		res, err := Run(context.Background(), slog.Default(), os.Args[0], "", "auth", "status")
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.Stdout != "auth\nstatus\n" || res.ExitCode != 0 {
			t.Errorf("got %+v", res)
		}
	})

	// The auth commands answer through their exit status, so a non-zero exit
	// is a result to read, not an error.
	t.Run("a non-zero exit is a result", func(t *testing.T) {
		t.Setenv(roleEnv, roleFail)
		res, err := Run(context.Background(), slog.Default(), os.Args[0], "")
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.ExitCode != 3 || res.Stdout != "progress\n" || res.Stderr != "Logout failed: no network\n" {
			t.Errorf("got %+v", res)
		}
	})

	t.Run("gives up when ctx is done", func(t *testing.T) {
		t.Setenv(roleEnv, roleLeaf)
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()

		start := time.Now()
		_, err := Run(ctx, slog.Default(), os.Args[0], "")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("got %v, want the deadline", err)
		}
		// The leaf sleeps for leafLifetime; returning long before that is what
		// shows it was killed rather than waited for.
		if elapsed := time.Since(start); elapsed > leafLifetime/2 {
			t.Errorf("Run took %s, so the CLI was waited out rather than killed", elapsed)
		}
	})

	t.Run("a CLI that is not installed says so", func(t *testing.T) {
		_, err := Run(context.Background(), slog.Default(), "pockode-test-no-such-cli", "")
		var notFound *BinaryNotFoundError
		if !errors.As(err, &notFound) {
			t.Fatalf("got %v, want *BinaryNotFoundError", err)
		}
	})
}
