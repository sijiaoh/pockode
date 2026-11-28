package session

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// crash abandons whatever the store still holds in memory, as a kill would.
func crash(s *FileStore) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.disarmFlushLocked()
	s.dirty = false
}

// reopen opens a store whose timer never fires within a test, so what reaches
// the disk is only what a durable write or Close put there.
func reopen(t *testing.T, dir string) *FileStore {
	t.Helper()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	store.flushDelay = time.Hour
	t.Cleanup(func() { crash(store) })
	return store
}

func mustGet(t *testing.T, r Reader, sessionID string) SessionMeta {
	t.Helper()
	meta, found, err := r.Get(sessionID)
	if err != nil || !found {
		t.Fatalf("Get(%s) = found %v, err %v", sessionID, found, err)
	}
	return meta
}

// What a crash takes of a turn's recoverable changes, startup repair puts back:
// a session killed mid-turn with a prompt on screen reads back the same whether
// or not the raise reached the disk.
func TestFileStore_CrashBeforeFlush_TurnReadsBackAsIfWritten(t *testing.T) {
	for _, flushed := range []bool{true, false} {
		dir := t.TempDir()
		store := reopen(t, dir)
		if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
			t.Fatalf("Create failed: %v", err)
		}
		if _, err := store.AppendToHistory(ctx, "s1", map[string]any{"type": "message"}); err != nil {
			t.Fatalf("AppendToHistory failed: %v", err)
		}
		if _, err := store.ApplyTurn(ctx, "s1", TurnInput{Signal: SignalPrompt, At: at(0)}); err != nil {
			t.Fatalf("ApplyTurn failed: %v", err)
		}
		if _, err := store.ApplyTurn(ctx, "s1", TurnInput{Signal: SignalPermissionRaised, RequestID: "r1", At: at(1)}); err != nil {
			t.Fatalf("ApplyTurn failed: %v", err)
		}
		if _, err := store.AppendToHistory(ctx, "s1", map[string]any{"type": "permission_request"}); err != nil {
			t.Fatalf("AppendToHistory failed: %v", err)
		}
		if flushed {
			if err := store.Close(); err != nil {
				t.Fatalf("Close failed: %v", err)
			}
		} else {
			crash(store)
		}

		restarted := reopen(t, dir)
		turn := mustGet(t, restarted, "s1").Turn
		if turn.Phase != PhaseIdle || turn.Open || len(turn.Blockers) != 0 || turn.LastOutcome != OutcomeAborted {
			t.Errorf("flushed=%v: turn = %+v, want an idle turn with nothing on screen, aborted", flushed, turn)
		}
		records, err := restarted.GetHistory(ctx, "s1")
		if err != nil {
			t.Fatalf("GetHistory failed: %v", err)
		}
		if len(records) != 3 || recordType(t, records[2]) != HistoryTypeProcessEnded {
			t.Errorf("flushed=%v: history = %s, want process_ended after the permission request", flushed, records)
		}
	}
}

// The changes nothing at startup could rebuild are on disk when the call
// returns, together with anything recoverable that was waiting for a write.
func TestFileStore_CrashKeepsDurableChanges(t *testing.T) {
	cost := 0.5
	cases := []struct {
		name   string
		change func(*FileStore) error
		check  func(*testing.T, SessionMeta)
	}{
		{
			name: "posted question",
			change: func(s *FileStore) error {
				_, err := s.ApplyTurn(ctx, "s1", TurnInput{
					Signal: SignalQuestionPosted, At: at(0),
					Question: &PendingQuestion{RequestID: "q1", Header: "h", Question: "q?"},
				})
				return err
			},
			check: func(t *testing.T, m SessionMeta) {
				if len(m.Turn.Unanswered) != 1 || m.Turn.Unanswered[0].RequestID != "q1" {
					t.Errorf("unanswered = %+v, want q1", m.Turn.Unanswered)
				}
			},
		},
		{
			name: "usage",
			change: func(s *FileStore) error {
				return s.AddUsage(ctx, "s1", UsageReport{Added: TokenUsage{OutputTokens: 7}, AddedCostUSD: &cost})
			},
			check: func(t *testing.T, m SessionMeta) {
				if m.Usage.OutputTokens != 7 || m.Usage.CostUSD == nil || *m.Usage.CostUSD != cost {
					t.Errorf("usage = %+v, want the report", m.Usage)
				}
			},
		},
		{
			name:   "first activation",
			change: func(s *FileStore) error { return s.Activate(ctx, "s1") },
			check: func(t *testing.T, m SessionMeta) {
				if !m.Activated {
					t.Error("session is not activated")
				}
			},
		},
		{
			name:   "title",
			change: func(s *FileStore) error { return s.Update(ctx, "s1", "Renamed") },
			check: func(t *testing.T, m SessionMeta) {
				if m.Title != "Renamed" {
					t.Errorf("title = %q", m.Title)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			store := reopen(t, dir)
			if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
				t.Fatalf("Create failed: %v", err)
			}
			// Pending when the durable change comes, which has to carry it.
			if err := store.SetUnread(ctx, "s1", true); err != nil {
				t.Fatalf("SetUnread failed: %v", err)
			}
			if err := tc.change(store); err != nil {
				t.Fatalf("change failed: %v", err)
			}
			crash(store)

			meta := mustGet(t, NewDirReader(dir), "s1")
			tc.check(t, meta)
			if !meta.Unread {
				t.Error("the pending unread did not go out with the durable write")
			}
		})
	}
}

// A recoverable change is held only for a bounded time, so a crash can take at
// most the last flushDelay of them.
func TestFileStore_RecoverableChangesReachDiskOnTheirOwn(t *testing.T) {
	dir := t.TempDir()
	store := reopen(t, dir)
	store.flushDelay = 10 * time.Millisecond
	if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if err := store.SetUnread(ctx, "s1", true); err != nil {
		t.Fatalf("SetUnread failed: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for !mustGet(t, NewDirReader(dir), "s1").Unread {
		if time.Now().After(deadline) {
			t.Fatal("the pending change never reached the disk")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A graceful stop loses nothing, and a change arriving after it — a late event
// from a process being torn down — is not left waiting for a timer.
func TestFileStore_CloseWritesPendingAndAfterwardsEverything(t *testing.T) {
	dir := t.TempDir()
	store := reopen(t, dir)
	if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if err := store.SetUnread(ctx, "s1", true); err != nil {
		t.Fatalf("SetUnread failed: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	if !mustGet(t, NewDirReader(dir), "s1").Unread {
		t.Error("Close did not write the pending change")
	}

	if err := store.SetUnread(ctx, "s1", false); err != nil {
		t.Fatalf("SetUnread failed: %v", err)
	}
	if mustGet(t, NewDirReader(dir), "s1").Unread {
		t.Error("a change after Close was held back")
	}
}

// A lost turn ending is harmless only because nothing downstream acts on an
// ending before it has had time to reach the disk (see recoverable).
func TestRecoverableFlushDelayIsShorterThanTheSettleDelay(t *testing.T) {
	if recoverableFlushDelay >= DefaultSettleDelay {
		t.Errorf("recoverableFlushDelay = %v, must be shorter than DefaultSettleDelay = %v", recoverableFlushDelay, DefaultSettleDelay)
	}
}

// A flush the disk refused is tried again on its own: a session that goes quiet
// must not keep its last changes in memory until the store closes.
func TestFileStore_FailedFlushIsRetried(t *testing.T) {
	dir := t.TempDir()
	store := reopen(t, dir)
	store.flushDelay = 10 * time.Millisecond
	if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	// A directory where the temp file goes makes every write fail.
	blocker := store.indexPath() + ".tmp"
	if err := os.Mkdir(blocker, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := store.SetUnread(ctx, "s1", true); err != nil {
		t.Fatalf("SetUnread failed: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if err := os.Remove(blocker); err != nil {
		t.Fatalf("remove: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for !mustGet(t, NewDirReader(dir), "s1").Unread {
		if time.Now().After(deadline) {
			t.Fatal("the refused flush was never retried")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Deferred changes are not worth bringing back a sessions directory removed on
// purpose under the store — by the timer, by Close, or after Close.
func TestFileStore_DeferredWritesDoNotRecreateARemovedDirectory(t *testing.T) {
	for _, name := range []string{"flush", "close", "after close"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			store := reopen(t, dir)
			if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
				t.Fatalf("Create failed: %v", err)
			}
			if name == "after close" {
				if err := store.Close(); err != nil {
					t.Fatalf("Close failed: %v", err)
				}
			}
			sessionsDir := filepath.Dir(store.indexPath())
			if err := os.RemoveAll(sessionsDir); err != nil {
				t.Fatalf("remove: %v", err)
			}
			if err := store.SetUnread(ctx, "s1", true); err != nil {
				t.Fatalf("SetUnread failed: %v", err)
			}
			switch name {
			case "flush":
				store.writeMu.Lock()
				gen := store.flushGen
				store.writeMu.Unlock()
				store.flushPending(gen)
			case "close":
				if err := store.Close(); err != nil {
					t.Fatalf("Close failed: %v", err)
				}
			}
			if _, err := os.Stat(sessionsDir); !errors.Is(err, fs.ErrNotExist) {
				t.Errorf("sessions directory recreated (stat err %v)", err)
			}
		})
	}
}
