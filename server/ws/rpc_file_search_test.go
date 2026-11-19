package ws

import (
	"context"
	"errors"
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/search"
)

// A search still running when the next one arrives is stopped — its context
// is what stops git and the scanning workers — and answered with a code the
// client can drop, while the newer one answers as usual.
func TestHandler_FileSearch_NewestWins(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	started := make(chan struct{})
	stopped := make(chan error, 1)
	env.handler.searchFiles = func(ctx context.Context, _ string, opts search.Options) (search.Result, error) {
		if opts.Query == "old" {
			close(started)
			<-ctx.Done()
			stopped <- context.Cause(ctx)
			// What a cancelled search.Search returns: a partial result.
			return search.Result{Truncated: true}, nil
		}
		return search.Result{Matches: []search.FileMatch{{Path: "new.go", Name: "new.go"}}}, nil
	}

	oldID := env.send("file.search", rpc.FileSearchParams{Query: "old"})
	<-started

	resp := env.call("file.search", rpc.FileSearchParams{Query: "new"})
	if resp.Error != nil {
		t.Fatalf("newer search failed: %s", resp.Error.Message)
	}
	if cause := <-stopped; !errors.Is(cause, errFileSearchSuperseded) {
		t.Errorf("older search ended with %v, want errFileSearchSuperseded", cause)
	}
	old := env.awaitResponse(oldID)
	if old.Error == nil || old.Error.Code != rpc.CodeFileSearchSuperseded {
		t.Errorf("older search answered %+v / %s, want CodeFileSearchSuperseded", old.Error, old.Result)
	}

	// A search that finished is not stopped by the next one: nothing is
	// running for it to supersede.
	if resp := env.call("file.search", rpc.FileSearchParams{Query: "new"}); resp.Error != nil {
		t.Errorf("search after a finished one failed: %s", resp.Error.Message)
	}
}

func TestFileSearches(t *testing.T) {
	superseded := func(ctx context.Context) bool {
		return errors.Is(context.Cause(ctx), errFileSearchSuperseded)
	}

	t.Run("a later arrival stops the running one", func(t *testing.T) {
		var s fileSearches
		older, finishOlder := s.start(context.Background(), "main", 1)
		newer, finishNewer := s.start(context.Background(), "main", 2)
		if !superseded(older) {
			t.Error("the older search is still running")
		}
		finishOlder()
		if newer.Err() != nil {
			t.Error("finishing the older search stopped the newer one")
		}
		finishNewer()
	})

	// Handlers run concurrently, so the older request can reach start second.
	t.Run("an earlier arrival starting second loses", func(t *testing.T) {
		var s fileSearches
		newer, finishNewer := s.start(context.Background(), "main", 2)
		older, finishOlder := s.start(context.Background(), "main", 1)
		if !superseded(older) {
			t.Error("the older search runs")
		}
		if newer.Err() != nil {
			t.Error("the older search stopped the newer one")
		}
		finishOlder()
		finishNewer()

		// Even once the newer one has finished.
		late, finishLate := s.start(context.Background(), "main", 1)
		if !superseded(late) {
			t.Error("an older search starting after the newer finished runs")
		}
		finishLate()
	})

	t.Run("worktrees do not supersede each other", func(t *testing.T) {
		var s fileSearches
		main, finishMain := s.start(context.Background(), "main", 1)
		_, finishOther := s.start(context.Background(), "feature", 2)
		if main.Err() != nil {
			t.Error("a search in another worktree stopped this one")
		}
		finishMain()
		finishOther()
	})
}
