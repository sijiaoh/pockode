package watch

import (
	"github.com/pockode/server/cliprofile"
)

// CLIProfileWatcher pushes the AI CLI profiles (cliprofile.Overview) to every
// client following them whenever this server changes them — a profile added,
// renamed, removed or made current. Notifications are cli_profile.changed.
//
// Only this server's changes are pushed. The list is a file every Pockode
// process of the OS user shares, and a change made by another cluster node or
// another project's server is not heard of here; a client sees it the next
// time it reads, or with the next change pushed, which reads the file afresh.
type CLIProfileWatcher struct {
	*latestWatcher[cliprofile.Overview]
}

func NewCLIProfileWatcher(read func() (cliprofile.Overview, error)) *CLIProfileWatcher {
	return &CLIProfileWatcher{newLatestWatcher("cli profiles", "cli_profile.changed", read,
		func(id string, profiles cliprofile.Overview) any {
			return cliProfileChangedParams{ID: id, Profiles: profiles}
		})}
}

// Changed tells the watcher this server has changed the profiles. Every RPC
// that changes them calls it once the change is stored.
func (w *CLIProfileWatcher) Changed() { w.changed() }

type cliProfileChangedParams struct {
	ID       string              `json:"id"`
	Profiles cliprofile.Overview `json:"profiles"`
}
