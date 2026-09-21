package watch

import (
	"log/slog"
	"sync"

	"github.com/pockode/server/work"
)

// SessionWorkSource is the whole of what a session watcher needs from the work
// layer: which work item a session runs. work.Store satisfies it.
//
// It is read rather than remembered because work.Work.SessionID *is* the
// relation — a copy of it on the session would be a second one, left behind by
// every rollback and every deletion that missed it.
//
// nil is tolerated, and reads every session as a plain chat session; narrow
// tests and any server built without a work store use that.
type SessionWorkSource interface {
	List() ([]work.Work, error)
	FindBySessionID(sessionID string) (work.Work, bool, error)
}

// sessionWorkIndex answers "which work item does this session run" and
// remembers the answer last put on the wire for each session.
//
// The memory is what keeps a work item's own churn off the wire: a work is
// written many times while it runs — a wait declared, a nudge counted, a step
// advanced — and none of it moves the one thing a session takes from it. Both
// watchers that carry the relation need exactly this bookkeeping, so it is
// written once here rather than twice.
//
// Kept per session rather than per subscription — the exception to the rule in
// docs/code/subscription-system.md — which each watcher has to earn: an entry is
// only sound while it names what *every* current subscriber holds. See
// SessionListWatcher.resetSentWorkIDs and SessionDetailWatcher.Subscribe.
type sessionWorkIndex struct {
	source SessionWorkSource

	mu   sync.Mutex
	sent map[string]string
}

func newSessionWorkIndex(source SessionWorkSource) *sessionWorkIndex {
	return &sessionWorkIndex{source: source, sent: make(map[string]string)}
}

// resolve reports the work item one session runs, and whether it could be
// resolved at all.
//
// An unreadable work index is not news about the session and there is nothing
// truthful to say about it, so the caller sends nothing — the same as a session
// the store fails to read (docs/code/subscription-system.md). Answering "belongs
// to no work" instead would put a task session into the list of every subscriber
// that asked not to see one, and hand the rest a session whose link to its work
// page has gone. The next event resolves it again.
func (i *sessionWorkIndex) resolve(sessionID string) (workID string, ok bool) {
	workID, err := i.resolveErr(sessionID)
	if err != nil {
		slog.Error("failed to look up the work a session belongs to", "sessionId", sessionID, "error", err)
		return "", false
	}
	return workID, true
}

// resolveErr is resolve for the one caller that has somewhere to report the
// failure: a subscribe, which answers the client and can refuse rather than
// hand it a snapshot that says the session belongs to no work.
func (i *sessionWorkIndex) resolveErr(sessionID string) (string, error) {
	if i.source == nil {
		return "", nil
	}
	item, found, err := i.source.FindBySessionID(sessionID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", nil
	}
	return item.ID, nil
}

// bySession indexes the whole work store by session id, for the paths that
// resolve a whole list and would otherwise read it once per row.
func (i *sessionWorkIndex) bySession() (map[string]string, error) {
	if i.source == nil {
		return nil, nil
	}
	works, err := i.source.List()
	if err != nil {
		return nil, err
	}
	return work.IDsBySession(works), nil
}

func (i *sessionWorkIndex) alreadySent(sessionID, workID string) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	sent, found := i.sent[sessionID]
	return found && sent == workID
}

// remember records the work id going out for a session and returns the one that
// went out last, so a caller can tell what this send changes.
func (i *sessionWorkIndex) remember(sessionID, workID string) (previous string, known bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	previous, known = i.sent[sessionID]
	i.sent[sessionID] = workID
	return previous, known
}

func (i *sessionWorkIndex) forget(sessionID string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	delete(i.sent, sessionID)
}

// reset replaces the whole record. Replaced rather than merged: the caller is
// handing over every session there is, so anything not in it no longer exists.
func (i *sessionWorkIndex) reset(entries map[string]string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.sent = entries
}
