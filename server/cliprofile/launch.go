package cliprofile

import (
	"fmt"
	"log/slog"

	"github.com/pockode/server/session"
)

// Selector names the profile a CLI is to be started as. The zero value is
// SelectCurrent.
type Selector struct {
	id       string
	explicit bool
}

// SelectCurrent is whichever profile is current when the CLI starts.
func SelectCurrent() Selector { return Selector{} }

// Select is the profile id, "" being the default one.
func Select(id string) Selector { return Selector{id: id, explicit: true} }

// Resolve turns sel into a profile ID, "" for the default profile. The current
// profile resolves to the default one where Availability says profiles cannot
// be used: the list is shared with every Pockode process of this OS user, and
// one that could make the directory may have chosen it. An explicit ID is not
// looked up here — Launch refuses one that cannot be used. A CLI this package
// has no layout for has only its default profile, and so does every CLI with a
// nil Store: Pockode on a machine with no configuration directory to keep
// profiles in.
func (s *Store) Resolve(agent session.AgentType, sel Selector) (string, error) {
	if sel.explicit {
		return sel.id, nil
	}
	if _, ok := layouts[agent]; !ok || s == nil {
		return "", nil
	}
	list, err := s.Load(agent)
	if err != nil {
		return "", err
	}
	if list.Current == "" {
		return "", nil
	}
	if a := s.Availability(); !a.Available {
		// Once: this runs on every start of the CLI, status reads included.
		s.unavailableWarning.Do(func() {
			slog.Warn("current AI CLI profile cannot be used on this machine; starting the CLI with the default profile",
				"cli", agent, "profile", list.Current, "reason", a.Reason)
		})
		return "", nil
	}
	return list.Current, nil
}

// Check refuses a selector naming a profile agent does not have, with
// ErrNotFound. It is for a profile ID that came from a client, checked before
// it is used for anything; the current profile and the default one ("") always
// pass.
func (s *Store) Check(agent session.AgentType, sel Selector) error {
	if !sel.explicit || sel.id == "" {
		return nil
	}
	if _, ok := layouts[agent]; !ok || s == nil {
		return fmt.Errorf("%w: %q", ErrNotFound, sel.id)
	}
	return s.requireListed(agent, sel.id)
}

// IDs is every profile of agent: the default one ("") first, then the stored
// ones in their order.
func (s *Store) IDs(agent session.AgentType) ([]string, error) {
	ids := []string{""}
	if _, ok := layouts[agent]; !ok || s == nil {
		return ids, nil
	}
	list, err := s.Load(agent)
	if err != nil {
		return nil, err
	}
	for _, p := range list.Profiles {
		ids = append(ids, p.ID)
	}
	return ids, nil
}

// Launch is what an AI CLI is started with to run as one profile.
type Launch struct {
	// ProfileID is the profile, "" for the default one.
	ProfileID string
	// Env is added to the CLI's environment, as "KEY=value". The default
	// profile adds nothing, so the CLI uses whatever directory it would
	// without Pockode.
	Env []string
	// Args are added to the CLI's command line where its other options go.
	// Only a non-default Codex profile has any.
	Args []string
}

// Launch prepares the profile sel names and returns what to start agent with
// to run as it. Every start of the CLI goes through it, since Prepare picks up
// what the default directory has gained since the last one.
//
// A profile that cannot be prepared is an error, never a quiet start as the
// default profile: that would run the user's work on an account they did not
// choose.
func (s *Store) Launch(agent session.AgentType, sel Selector) (Launch, error) {
	id, err := s.Resolve(agent, sel)
	if err != nil {
		return Launch{}, err
	}
	if id == "" {
		return Launch{}, nil
	}
	if s == nil {
		return Launch{}, fmt.Errorf("%w: %w", ErrSymlinksUnavailable, ErrNoStore)
	}
	l, err := layoutOf(agent)
	if err != nil {
		return Launch{}, err
	}
	// Conflicts are no reason not to start: Prepare has logged them, and the
	// profile works without sharing those entries.
	if _, err := s.Prepare(agent, id); err != nil {
		return Launch{}, fmt.Errorf("prepare the %s profile %s: %w", agent, id, err)
	}
	dir, err := s.Dir(agent, id)
	if err != nil {
		return Launch{}, err
	}
	env := []string{l.envVar + "=" + dir}
	for _, name := range l.launchEnv {
		env = append(env, name+"="+dir)
	}
	return Launch{ProfileID: id, Env: env, Args: append([]string(nil), l.launchArgs...)}, nil
}
