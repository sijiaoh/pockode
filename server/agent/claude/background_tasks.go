package claude

import (
	"encoding/json"
	"log/slog"
	"sync"
)

// backgroundTaskTracker holds the live background tasks of one CLI process.
//
// Why it exists: after starting a background task the CLI ends the turn with an
// ordinary result frame and later resumes output on its own, without the host
// sending anything. The two result frames are byte-identical in every field, so
// the only way to tell "the turn is really over" from "waiting on background
// work" is this level signal.
//
// Where: `system` / `background_tasks_changed`, whose payload is every live task
// after the change (REPLACE semantics). The level is per-process — the CLI emits
// nothing at startup — so a tracker created with the process starts empty, which
// is exactly right.
//
// This is live state, not history: it is never written into an event record,
// because a snapshot of it turns into a lie the moment a task finishes.
type backgroundTaskTracker struct {
	liveMu sync.Mutex
	live   []string

	// The swallowing cannot be open-ended, so every swallowed ending is held by
	// this timer and delivered anyway once the budget runs out.
	wait backgroundWait
}

type backgroundTask struct {
	TaskID   string `json:"task_id"`
	TaskType string `json:"task_type"`
	// Ambient marks tasks that are not activity (housekeeping, live-update
	// watchers). The CLI tells hosts to exclude them from activity indicators,
	// so they must not hold a turn open either.
	Ambient bool `json:"ambient"`
}

type backgroundTasksChanged struct {
	Tasks []backgroundTask `json:"tasks"`
}

// observe replaces the tracked set with the payload of a
// background_tasks_changed frame.
func (t *backgroundTaskTracker) observe(log *slog.Logger, line []byte) {
	// A payload this code cannot read empties the set rather than leaving the
	// previous one in place: an empty set only costs the swallowing (the turn
	// ends the way it did before this existed, noisily but recoverably), while a
	// stale non-empty one holds the turn open forever with nothing left to clear
	// it. Same reason a malformed control request is declined instead of dropped
	// — unknown input takes the recoverable branch.
	var payload backgroundTasksChanged
	if err := json.Unmarshal(line, &payload); err != nil {
		log.Warn("failed to parse background task list from CLI, treating it as empty", "error", err)
		payload = backgroundTasksChanged{}
	}

	live := make([]string, 0, len(payload.Tasks))
	for _, task := range payload.Tasks {
		if task.Ambient {
			continue
		}
		live = append(live, task.TaskID)
	}

	t.liveMu.Lock()
	t.live = live
	t.liveMu.Unlock()

	log.Debug("background tasks changed", "live", live)
}

// liveCount reports how many non-ambient background tasks are still running.
func (t *backgroundTaskTracker) liveCount() int {
	t.liveMu.Lock()
	defer t.liveMu.Unlock()
	return len(t.live)
}

// hasLive reports whether any non-ambient background task is still running.
func (t *backgroundTaskTracker) hasLive() bool {
	return t.liveCount() > 0
}

// waitingForBackgroundWork reports whether Pockode is currently holding a turn
// open on behalf of background work.
//
// Deliberately not "is the live set non-empty": the set only shrinks when the
// CLI sends another frame, so a silent or dead process would keep it non-empty
// forever. The fallback timer is armed exactly while an ending is being held
// back and clears itself when the budget runs out, so callers get an exemption
// that expires on its own.
func (t *backgroundTaskTracker) waitingForBackgroundWork() bool {
	return t.wait.armed()
}
