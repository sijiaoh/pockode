package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/filestore"
)

const backgroundLossFile = "background_tasks_lost.json"

// The three tellings of "it must not be silent", as for the wait fallback: the
// sentence the user reads in the transcript, what the agent is told on its next
// prompt, and — the only one that lands on the rows that are wrong — the result
// each killed call is settled with.
const (
	backgroundTasksLostCode    = "background_tasks_lost"
	backgroundTasksLostWarning = "The previous Claude process for this session ended with %s still running (a server restart, " +
		"an idle timeout, or a stop). Background tasks do not survive that, so nothing they would have reported is coming — " +
		"start that work again if you still need the result."
	backgroundTasksLostNote = "Pockode's previous CLI process for this session ended with %s still running, and background " +
		"tasks do not survive that: they were killed and produced no result. Do not wait for them and do not expect " +
		"BashOutput to return anything for them — start the work again if you still need it."

	// It says where the ending came from, because Pockode is asserting an
	// outcome the CLI never reported. That assertion is honest — Pockode killed
	// the process or watched it die, and background work does not survive that —
	// but only while it is attributed. The subtype says the same thing to the
	// client; this sentence says it to whoever reads the transcript.
	backgroundCallLostText = "This background task did not finish: Pockode's CLI process ended while it was still running, which kills it. " +
		"Pockode is reporting that from having seen the process end — the CLI never reported an outcome for this task and never will."
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
	return backgroundLossStore{path: filepath.Join(sessionDir(opts.DataDir, opts.SessionID), backgroundLossFile)}
}

// backgroundLossRecord is what one dead process left behind: how many tasks it
// took down, and which tool calls they belonged to.
type backgroundLossRecord struct {
	LostTasks int `json:"lostTasks"`
	// LostCalls are the calls whose background work died, by tool_use_id, so the
	// next process can settle each of those rows instead of leaving them saying
	// "still running" forever.
	//
	// Optional on read, which is what keeps records written before this field
	// existed readable: they carry the count alone, and the count is all the
	// warning below needs. A loss explained to the user in full but in summary
	// is the old behaviour, not a failure.
	LostCalls []string `json:"lostCalls,omitempty"`
}

// reportable says whether there is anything to hand to the next process.
func (r backgroundLossRecord) reportable() bool {
	return r.LostTasks > 0 || len(r.LostCalls) > 0
}

// record notes what died with this process.
func (s backgroundLossStore) record(log *slog.Logger, loss backgroundLossRecord) {
	if s.path == "" || !loss.reportable() {
		return
	}

	data, err := json.Marshal(loss)
	if err != nil {
		log.Error("failed to marshal lost background tasks", "error", err)
		return
	}
	if err := filestore.WriteFileAtomic(s.path, data, 0644); err != nil {
		log.Error("failed to record lost background tasks", "error", err)
		return
	}
	log.Warn("background tasks were still running when the process ended",
		"lost", loss.LostTasks, "calls", loss.LostCalls)
}

// peek reports the loss left by the previous process without consuming it; the
// caller clears it once the explanation has actually been handed over.
func (s backgroundLossStore) peek(log *slog.Logger) backgroundLossRecord {
	if s.path == "" {
		return backgroundLossRecord{}
	}

	// Read without locking: the record is written by rename, so a reader either
	// sees the whole previous file or the whole new one, and this server is the
	// only thing that touches it. Locking here would only litter every session
	// directory with a lock file for a read that almost always finds nothing.
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return backgroundLossRecord{}
	}
	if err != nil {
		log.Warn("failed to read lost background tasks", "error", err)
		return backgroundLossRecord{}
	}

	var record backgroundLossRecord
	if err := json.Unmarshal(data, &record); err != nil {
		// Nothing can be reported from an unreadable record, and keeping it would
		// mean retrying the same failure on every future start.
		log.Warn("failed to parse lost background tasks, discarding the record", "error", err)
		s.clear(log)
		return backgroundLossRecord{}
	}
	return record
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

// deliverBackgroundLoss tells the session about background work the previous
// process took down with it: one settled result for each call that was left
// running, then the sentence that explains why they all ended at once.
//
// It reports whether everything got through, because the caller may only forget
// the loss once it has.
//
// Per-call results arrive first so that the rows are already true by the time
// the explanation is read. They are ordinary tool results, which means the
// process counts as running while they stream (EventType.IndicatesAgentActivity)
// — and that is accurate rather than incidental: a CLI process is only ever
// started to carry a message, so a turn is under way here and will end with a
// done event of its own.
func deliverBackgroundLoss(ctx context.Context, events chan<- agent.AgentEvent, loss backgroundLossRecord) bool {
	for _, toolUseID := range loss.LostCalls {
		lost := agent.ToolResultEvent{
			ToolUseID:  toolUseID,
			ToolResult: backgroundCallLostText,
			Subtype:    agent.ToolResultBackgroundLost,
			// The work did not do what it was asked to do, and nothing later can
			// change that: this is the call's final state.
			IsError: true,
		}
		if !emitEvent(ctx, events, lost) {
			return false
		}
	}

	// The count comes from the background task level and the ids from the task
	// lifecycle, which the CLI's schema says must not be correlated — so a
	// record may hold ids and no count, and then the rows above are the whole of
	// what can honestly be said.
	if loss.LostTasks == 0 {
		return true
	}
	return emitEvent(ctx, events, agent.WarningEvent{
		Message: fmt.Sprintf(backgroundTasksLostWarning, backgroundTaskCount(loss.LostTasks)),
		Code:    backgroundTasksLostCode,
	})
}

// emitEvent hands one event to a channel that only has a consumer for as long as
// the process lives, and reports whether it was taken.
func emitEvent(ctx context.Context, events chan<- agent.AgentEvent, event agent.AgentEvent) bool {
	select {
	case events <- event:
		return true
	case <-ctx.Done():
		return false
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
