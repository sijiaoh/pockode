package watch

import (
	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/session"
)

// CLILoginWatcher pushes each change to a CLI's sign-in to the clients
// following that CLI. A sign-in ends on its own — Codex finishes when the user
// is done in the browser. Notifications are cli_auth.login.changed.
type CLILoginWatcher struct {
	*cliRecordWatcher[cliauth.Login]
}

func NewCLILoginWatcher(logins *cliauth.Service) *CLILoginWatcher {
	w := &CLILoginWatcher{newCLIRecordWatcher("sign-ins", "cli_auth.login.changed", logins.Login,
		func(id string, login *cliauth.Login) any { return cliLoginChangedParams{ID: id, Login: login} })}
	logins.AddLoginListener(w)
	return w
}

// OnLoginChange implements cliauth.LoginListener.
func (w *CLILoginWatcher) OnLoginChange(agentType session.AgentType) { w.changed(agentType) }

type cliLoginChangedParams struct {
	ID    string         `json:"id"`
	Login *cliauth.Login `json:"login"`
}
