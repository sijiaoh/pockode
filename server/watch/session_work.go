package watch

import (
	"log/slog"
	"slices"
	"sync"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
)

// SessionWorkSource is the whole of what a session watcher needs from the work
// layer: which work item a session runs, and which stories it watches.
// work.Store satisfies it.
//
// It is read rather than remembered because work.Work.SessionID and
// work.Work.Watcher *are* the relations — a copy of either on the session would
// be a second one, left behind by every rollback and every deletion that missed
// it.
//
// nil is tolerated, and reads every session as a plain chat session; narrow
// tests and any server built without a work store use that.
type SessionWorkSource interface {
	List() ([]work.Work, error)
	FindBySessionID(sessionID string) (work.Work, bool, error)
	WatchedBy(sessionID string) ([]work.Work, error)
}

// sessionWorkIndex answers "which work item does this session run, and which
// stories does it watch" and remembers the answer last put on the wire for
// each session.
//
// The memory is what keeps a work item's own churn off the wire: a work is
// written many times while it runs — a wait declared, a nudge counted, a step
// advanced — and almost none of it moves what a session takes from it. Both
// watchers that carry the relation need exactly this bookkeeping, so it is
// written once here rather than twice; what each of them puts on the wire
// differs, so each says what counts as a change (same).
//
// Kept per session rather than per subscription — the exception to the rule in
// docs/code/subscription-system.md — which each watcher has to earn: an entry is
// only sound while it names what *every* current subscriber holds. See
// SessionListWatcher.resetSentWorkIDs and SessionDetailWatcher.Subscribe.
type sessionWorkIndex struct {
	source SessionWorkSource
	// same reports whether two relations put the same thing on the wire.
	same func(a, b rpc.SessionWork) bool

	mu   sync.Mutex
	sent map[string]rpc.SessionWork
}

func newSessionWorkIndex(source SessionWorkSource, same func(a, b rpc.SessionWork) bool) *sessionWorkIndex {
	return &sessionWorkIndex{source: source, same: same, sent: make(map[string]rpc.SessionWork)}
}

// sameRow is what a session row carries: the work id and a count. A watched
// story being retitled or stopped is not news to it.
func sameRow(a, b rpc.SessionWork) bool {
	return a.WorkID == b.WorkID && len(a.Watched) == len(b.Watched)
}

// sameDetail is what a session detail carries: the work id and every watched
// story it lists.
func sameDetail(a, b rpc.SessionWork) bool {
	return a.WorkID == b.WorkID && slices.Equal(a.Watched, b.Watched)
}

// resolve reports one session's relation to the work layer, and whether it
// could be resolved at all.
//
// An unreadable work index is not news about the session and there is nothing
// truthful to say about it, so the caller sends nothing — the same as a session
// the store fails to read (docs/code/subscription-system.md). Answering "belongs
// to no work" instead would put a task session into the list of every subscriber
// that asked not to see one, and hand the rest a session whose link to its work
// page has gone. The next event resolves it again.
func (i *sessionWorkIndex) resolve(sessionID string) (rpc.SessionWork, bool) {
	sw, err := i.resolveErr(sessionID)
	if err != nil {
		slog.Error("failed to look up the work a session belongs to", "sessionId", sessionID, "error", err)
		return rpc.SessionWork{}, false
	}
	return sw, true
}

// resolveErr is resolve for the one caller that has somewhere to report the
// failure: a subscribe, which answers the client and can refuse rather than
// hand it a snapshot that says the session belongs to no work.
func (i *sessionWorkIndex) resolveErr(sessionID string) (rpc.SessionWork, error) {
	if i.source == nil {
		return rpc.SessionWork{}, nil
	}
	return ResolveSessionWork(i.source, sessionID)
}

// ResolveSessionWork reads one session's relation to the work layer.
func ResolveSessionWork(source SessionWorkSource, sessionID string) (rpc.SessionWork, error) {
	item, found, err := source.FindBySessionID(sessionID)
	if err != nil {
		return rpc.SessionWork{}, err
	}
	watched, err := source.WatchedBy(sessionID)
	if err != nil {
		return rpc.SessionWork{}, err
	}
	workID := ""
	if found {
		workID = item.ID
	}
	return rpc.NewSessionWork(workID, watched), nil
}

// bySession indexes the whole work store by session id, for the paths that
// resolve a whole list and would otherwise read it once per row. A session
// missing from the map belongs to no work and watches nothing.
func (i *sessionWorkIndex) bySession() (map[string]rpc.SessionWork, error) {
	if i.source == nil {
		return nil, nil
	}
	works, err := i.source.List()
	if err != nil {
		return nil, err
	}
	return rpc.SessionWorkBySession(works), nil
}

// sessionsTouchedBy names the sessions whose relation to the work layer one
// work change can move: the session the work runs in, and whoever watched the
// story before and after the change — the close or the unwatch that releases a
// watcher names it only as the previous one. Each at most once.
func sessionsTouchedBy(event work.ChangeEvent) []string {
	candidates := []string{event.Work.SessionID}
	if event.Work.Watcher != nil {
		candidates = append(candidates, event.Work.Watcher.SessionID)
	}
	if event.PrevWatcher != nil {
		candidates = append(candidates, event.PrevWatcher.SessionID)
	}
	var ids []string
	for _, id := range candidates {
		if id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids
}

func (i *sessionWorkIndex) alreadySent(sessionID string, sw rpc.SessionWork) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	sent, found := i.sent[sessionID]
	return found && i.same(sent, sw)
}

// remember records the relation going out for a session and returns the one
// that went out last, so a caller can tell what this send changes.
func (i *sessionWorkIndex) remember(sessionID string, sw rpc.SessionWork) (previous rpc.SessionWork, known bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	previous, known = i.sent[sessionID]
	i.sent[sessionID] = sw
	return previous, known
}

func (i *sessionWorkIndex) forget(sessionID string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	delete(i.sent, sessionID)
}

// reset replaces the whole record. Replaced rather than merged: the caller is
// handing over every session there is, so anything not in it no longer exists.
func (i *sessionWorkIndex) reset(entries map[string]rpc.SessionWork) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.sent = entries
}
