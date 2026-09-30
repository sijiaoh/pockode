package watch

import (
	"github.com/pockode/server/cliupdate"
	"github.com/pockode/server/session"
)

// CLIUpdateWatcher pushes each change to a CLI's update to the clients
// following that CLI. An update runs for tens of seconds, longer than a
// request is worth holding open. Notifications are cli_update.changed.
type CLIUpdateWatcher struct {
	*cliRecordWatcher[cliupdate.Update]
}

func NewCLIUpdateWatcher(updates *cliupdate.Service) *CLIUpdateWatcher {
	w := &CLIUpdateWatcher{newCLIRecordWatcher("updates", "cli_update.changed", updates.Update,
		func(id string, update *cliupdate.Update) any { return cliUpdateChangedParams{ID: id, Update: update} })}
	updates.AddListener(w)
	return w
}

// OnUpdateChange implements cliupdate.Listener.
func (w *CLIUpdateWatcher) OnUpdateChange(agentType session.AgentType) { w.changed(agentType) }

type cliUpdateChangedParams struct {
	ID     string            `json:"id"`
	Update *cliupdate.Update `json:"update"`
}
