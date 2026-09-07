package claude

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/filestore"
)

const backgroundLossFile = "background_tasks_lost.json"

// The two halves of "it must not be silent", as for the wait fallback: what the
// user reads in the transcript, and what the agent is told on its next prompt.
const (
	backgroundTasksLostCode    = "background_tasks_lost"
	backgroundTasksLostWarning = "The previous Claude process for this session ended with %s still running (a server restart, " +
		"an idle timeout, or a stop). Background tasks do not survive that, so nothing they would have reported is coming — " +
		"start that work again if you still need the result."
	backgroundTasksLostNote = "Pockode's previous CLI process for this session ended with %s still running, and background " +
		"tasks do not survive that: they were killed and produced no result. Do not wait for them and do not expect " +
		"BashOutput to return anything for them — start the work again if you still need it."
)

// backgroundLossStore remembers, across process restarts, that a CLI process was
// killed while background tasks were still running.
//
// Why it has to be persisted rather than reported on the spot: background tasks
// live inside the CLI process, so an idle reap, a stop, or a server restart
// takes them with it — and at that moment there is nowhere to say so. The event
// channel and the session history are closing behind the process, and on a
// server shutdown the whole write path is going away. Telling the user when the
// session next starts is the one delivery that works for every way a process can
// die, and it lands exactly when it matters: the moment the conversation that
// was waiting for those tasks continues.
//
// An empty path disables the store, for sessions started without a data
// directory to keep it in (tests, anonymous sessions).
type backgroundLossStore struct {
	path string
}

func newBackgroundLossStore(opts agent.StartOptions) backgroundLossStore {
	if opts.SessionID == "" || opts.DataDir == "" {
		return backgroundLossStore{}
	}
	return backgroundLossStore{path: filepath.Join(opts.DataDir, "sessions", opts.SessionID, backgroundLossFile)}
}

type backgroundLossRecord struct {
	LostTasks int `json:"lostTasks"`
}

// record notes that count background tasks died with this process.
func (s backgroundLossStore) record(log *slog.Logger, count int) {
	if s.path == "" || count <= 0 {
		return
	}

	data, err := json.Marshal(backgroundLossRecord{LostTasks: count})
	if err != nil {
		log.Error("failed to marshal lost background tasks", "error", err)
		return
	}
	if err := filestore.WriteFileAtomic(s.path, data, 0644); err != nil {
		log.Error("failed to record lost background tasks", "error", err)
		return
	}
	log.Warn("background tasks were still running when the process ended", "lost", count)
}

// peek reports the loss left by the previous process without consuming it; the
// caller clears it once the explanation has actually been handed over.
func (s backgroundLossStore) peek(log *slog.Logger) int {
	if s.path == "" {
		return 0
	}

	// Read without locking: the record is written by rename, so a reader either
	// sees the whole previous file or the whole new one, and this server is the
	// only thing that touches it. Locking here would only litter every session
	// directory with a lock file for a read that almost always finds nothing.
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		log.Warn("failed to read lost background tasks", "error", err)
		return 0
	}

	var record backgroundLossRecord
	if err := json.Unmarshal(data, &record); err != nil {
		// Nothing can be reported from an unreadable record, and keeping it would
		// mean retrying the same failure on every future start.
		log.Warn("failed to parse lost background tasks, discarding the record", "error", err)
		s.clear(log)
		return 0
	}
	return record.LostTasks
}

// clear drops the record, so the explanation is delivered exactly once.
func (s backgroundLossStore) clear(log *slog.Logger) {
	if s.path == "" {
		return
	}
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		log.Warn("failed to clear lost background tasks", "error", err)
	}
}

// backgroundTaskCount phrases a task count so the sentence around it reads the
// same for one task and for many.
func backgroundTaskCount(n int) string {
	if n == 1 {
		return "1 background task"
	}
	return fmt.Sprintf("%d background tasks", n)
}
