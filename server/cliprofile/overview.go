package cliprofile

import (
	"fmt"

	"github.com/pockode/server/session"
)

// Overview is what a user is shown of the profiles: whether this machine can
// use them, and each CLI's list. Only the stored list is in it. Sign-in states
// and Conflicts come from the CLIs' directories, which change without this
// file changing, so they are read when asked for rather than kept beside it.
type Overview struct {
	Availability
	CLIs []CLIOverview `json:"clis"`
}

// CLIOverview is one CLI's profiles. The default profile is not among
// Profiles: every CLI has it, it has no ID ("") and no name of its own.
type CLIOverview struct {
	Agent session.AgentType `json:"agent"`
	// CurrentProfileID is the profile chosen as current, absent for the
	// default one. Where Availability says profiles cannot be used the CLI
	// runs as its default profile whatever is chosen (see Resolve): the
	// choice is still shown, since the list is shared with every Pockode
	// process of this OS user and one that can use profiles follows it.
	CurrentProfileID string    `json:"current_profile_id,omitempty"`
	Profiles         []Profile `json:"profiles"`
}

// Overview reads the lists of agents, in that order. The nil Store has an
// empty list for each.
func (s *Store) Overview(agents []session.AgentType) (Overview, error) {
	o := Overview{Availability: s.Availability(), CLIs: make([]CLIOverview, 0, len(agents))}
	for _, agent := range agents {
		list, err := s.Load(agent)
		if err != nil {
			return Overview{}, fmt.Errorf("read the %s profiles: %w", agent, err)
		}
		o.CLIs = append(o.CLIs, CLIOverview{Agent: agent, CurrentProfileID: list.Current, Profiles: list.Profiles})
	}
	return o, nil
}
