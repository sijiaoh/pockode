package cliprofile

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pockode/server/internal/fsperm"
)

// Availability is whether this machine can have profiles other than the
// default one. A profile directory shares everything but credentials by
// symbolic links, files among them: a junction links only directories, and a
// hard link to a SQLite database that is replaced or rewritten splits the two
// copies, so nothing else will do.
type Availability struct {
	Available bool `json:"available"`
	// Reason says, for the user, why profiles are unavailable; "" when they
	// are available.
	Reason string `json:"unavailable_reason,omitempty"`
}

// Availability probes once per Store, by creating a file symlink where profile
// directories live; whether the OS allows it does not change while Pockode
// runs (turning on Windows Developer Mode takes effect for new processes). The
// nil Store has no profiles to use, for want of a place to keep them.
func (s *Store) Availability() Availability {
	if s == nil {
		return Availability{Reason: ErrNoStore.Error()}
	}
	s.availabilityOnce.Do(func() {
		s.availability = probeSymlinks(filepath.Dir(s.path))
	})
	return s.availability
}

func probeSymlinks(dir string) Availability {
	unavailable := func(err error) Availability {
		return Availability{Reason: fmt.Sprintf("Pockode could not test creating symbolic links in %s: %v", dir, err)}
	}
	if err := fsperm.RestrictDir(dir); err != nil {
		return unavailable(err)
	}
	probe, err := os.MkdirTemp(dir, "symlink-probe-")
	if err != nil {
		return unavailable(err)
	}
	defer os.RemoveAll(probe)

	target := filepath.Join(probe, "target")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		return unavailable(err)
	}
	if err := os.Symlink(target, filepath.Join(probe, "link")); err != nil {
		return Availability{Reason: symlinkRefusedReason(dir, err)}
	}
	return Availability{Available: true}
}
