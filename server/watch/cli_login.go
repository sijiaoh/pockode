package watch

import (
	"log/slog"
	"sync"

	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/session"
)

// CLILoginWatcher pushes each change to a CLI's sign-in to the clients
// following that CLI. A sign-in ends on its own — Codex finishes when the user
// is done in the browser — so a client cannot learn how it went by asking
// after something it did.
//
// Every notification carries the whole sign-in as it is when sent, never a
// delta, so changes that pile up while one is being sent collapse into one.
type CLILoginWatcher struct {
	*BaseWatcher
	logins *cliauth.Service

	pendingMu sync.Mutex
	pending   map[session.AgentType]struct{}
	wake      chan struct{}
}

func NewCLILoginWatcher(logins *cliauth.Service) *CLILoginWatcher {
	w := &CLILoginWatcher{
		BaseWatcher: NewBaseWatcher(),
		logins:      logins,
		pending:     make(map[session.AgentType]struct{}),
		wake:        make(chan struct{}, 1),
	}
	logins.AddLoginListener(w)
	return w
}

func (w *CLILoginWatcher) Start() error {
	w.Go(w.eventLoop)
	slog.Info("CLILoginWatcher started")
	return nil
}

func (w *CLILoginWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("CLILoginWatcher stopped")
}

// OnLoginChange implements cliauth.LoginListener. It never blocks and never
// drops a change: the CLI is marked, and the loop sends what it is by then.
func (w *CLILoginWatcher) OnLoginChange(agentType session.AgentType) {
	w.pendingMu.Lock()
	w.pending[agentType] = struct{}{}
	w.pendingMu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *CLILoginWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case <-w.wake:
		}
		w.pendingMu.Lock()
		pending := w.pending
		w.pending = make(map[session.AgentType]struct{})
		w.pendingMu.Unlock()

		for agentType := range pending {
			if !w.HasSubscriptionForKey(string(agentType)) {
				continue
			}
			login, err := w.logins.Login(agentType)
			if err != nil {
				slog.Error("failed to read CLI sign-in for notification", "cli", agentType, "error", err)
				continue
			}
			w.NotifyForKey(string(agentType), "cli_auth.login.changed", func(sub *Subscription) any {
				return cliLoginChangedParams{ID: sub.ID, Login: login}
			})
		}
	}
}

type cliLoginChangedParams struct {
	ID    string         `json:"id"`
	Login *cliauth.Login `json:"login"`
}

// Subscribe follows agentType's sign-in and returns its latest — running, or
// the last to end, so that a client back from a reload or a dropped
// connection learns how it went — or nil when it has had none.
func (w *CLILoginWatcher) Subscribe(id string, agentType session.AgentType, notifier Notifier) (*cliauth.Login, error) {
	// Read first: an unknown CLI must not leave a subscription behind.
	if _, err := w.logins.Login(agentType); err != nil {
		return nil, err
	}
	if err := w.AddSubscription(&Subscription{ID: id, Key: string(agentType), Notifier: notifier}); err != nil {
		return nil, err
	}
	// Read again after subscribing: a change in between is then either in this
	// answer or in a notification, never lost between the two.
	return w.logins.Login(agentType)
}
