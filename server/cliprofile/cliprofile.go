// Package cliprofile keeps the accounts (profiles) registered for each AI CLI
// and which one is current: cli-profiles.json in the OS user's configuration
// directory, next to cloudcred's cloud.json and for the same reason — every
// Pockode process the OS user runs, servers in different projects, a cluster
// and the nodes it starts, reads and changes the same list.
//
// The default profile is implicit and never stored: it is whatever directory
// the CLI uses without Pockode's help (~/.claude, ~/.codex, or the
// CLAUDE_CONFIG_DIR / CODEX_HOME the user started Pockode with). Every stored
// profile has a directory of its own, named by its ID; its name lives only in
// the metadata, so renaming never moves a directory a running CLI has open.
package cliprofile

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/pockode/server/filestore"
	"github.com/pockode/server/internal/fsperm"
	"github.com/pockode/server/session"
)

// MaxNameLength is the longest profile name accepted, in characters.
const MaxNameLength = 64

var (
	ErrUnsupportedAgent = errors.New("unsupported AI CLI")
	ErrNotFound         = errors.New("profile not found")
	ErrInvalidName      = fmt.Errorf("profile name must be 1 to %d characters with no control characters", MaxNameLength)
	ErrNameTaken        = errors.New("another profile of this AI CLI already has that name")
)

// errDamaged is a file that failed to parse while a change held its lock; the
// change quarantines it and retries over the empty list.
var errDamaged = errors.New("profile file is damaged")

type Profile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// List is one CLI's profiles. Current is the ID of the profile in use, or ""
// for the default one.
type List struct {
	Current  string    `json:"current,omitempty"`
	Profiles []Profile `json:"profiles"`
}

func (l *List) index(id string) int {
	return slices.IndexFunc(l.Profiles, func(p Profile) bool { return p.ID == id })
}

// file is the stored document. A CLI with no profiles is absent rather than
// stored empty.
type file map[session.AgentType]*List

type Store struct {
	path    string
	baseDir string

	availabilityOnce sync.Once
	availability     Availability
	// unavailableWarning logs, once, that the current profile is passed over
	// because profiles cannot be used here.
	unavailableWarning sync.Once
}

// DefaultStore is the store every Pockode process of this OS user shares.
func DefaultStore() (*Store, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return NewStore(configDir), nil
}

// NewStore keeps cli-profiles.json, and the profile directories under
// cli-profiles/, in configDir/pockode.
func NewStore(configDir string) *Store {
	dir := filepath.Join(configDir, "pockode")
	return &Store{
		path:    filepath.Join(dir, "cli-profiles.json"),
		baseDir: filepath.Join(dir, "cli-profiles"),
	}
}

// Dir is where the profile id of agent keeps its CLI directory — the value of
// CLAUDE_CONFIG_DIR or CODEX_HOME when it is current. It only computes the
// path: nothing is created, and id is not looked up. The id is checked to be
// one this package could have issued, since it ends up in a path and may come
// from a client.
func (s *Store) Dir(agent session.AgentType, id string) (string, error) {
	if !agent.IsValid() {
		return "", fmt.Errorf("%w: %q", ErrUnsupportedAgent, agent)
	}
	if !validID(id) {
		return "", fmt.Errorf("%w: %q", ErrNotFound, id)
	}
	return filepath.Join(s.baseDir, string(agent), id), nil
}

// Load returns agent's profiles. No file, or a damaged one that had to be
// quarantined, is an empty list with the default profile current.
func (s *Store) Load(agent session.AgentType) (List, error) {
	if !agent.IsValid() {
		return List{}, fmt.Errorf("%w: %q", ErrUnsupportedAgent, agent)
	}
	var f file
	found, err := filestore.ReadJSONOrQuarantine(s.path, "AI CLI profiles", &f)
	if err != nil || !found {
		return List{Profiles: []Profile{}}, err
	}
	return f.list(agent), nil
}

// Current returns agent's current profile, or nil for the default one.
func (s *Store) Current(agent session.AgentType) (*Profile, error) {
	list, err := s.Load(agent)
	if err != nil {
		return nil, err
	}
	if list.Current == "" {
		return nil, nil
	}
	return &list.Profiles[list.index(list.Current)], nil
}

// Add registers a new profile named name for agent. It does not become
// current, and its directory is not created.
func (s *Store) Add(agent session.AgentType, name string) (Profile, error) {
	name, err := normalizeName(name)
	if err != nil {
		return Profile{}, err
	}
	p := Profile{ID: uuid.Must(uuid.NewV7()).String(), Name: name}
	err = s.update(agent, func(l *List) error {
		if nameTaken(l, name, "") {
			return ErrNameTaken
		}
		l.Profiles = append(l.Profiles, p)
		return nil
	})
	if err != nil {
		return Profile{}, err
	}
	return p, nil
}

func (s *Store) Rename(agent session.AgentType, id, name string) error {
	name, err := normalizeName(name)
	if err != nil {
		return err
	}
	return s.update(agent, func(l *List) error {
		i := l.index(id)
		if i < 0 {
			return fmt.Errorf("%w: %q", ErrNotFound, id)
		}
		if nameTaken(l, name, id) {
			return ErrNameTaken
		}
		l.Profiles[i].Name = name
		return nil
	})
}

// SetCurrent makes the profile id current for agent; "" makes it the default
// one.
func (s *Store) SetCurrent(agent session.AgentType, id string) error {
	return s.update(agent, func(l *List) error {
		if id != "" && l.index(id) < 0 {
			return fmt.Errorf("%w: %q", ErrNotFound, id)
		}
		l.Current = id
		return nil
	})
}

// Remove forgets the profile id and deletes its directory, with whatever
// credentials are in it; the links in it are removed, never followed. If it
// was current, the default profile becomes current.
//
// Credentials kept outside the directory are not touched: Claude Code on
// macOS keeps them in a Keychain item named after the directory, so a caller
// signs the profile out first. Nor does it stop a CLI still running as the
// profile, which would recreate the directory; the caller sees to that too.
//
// The metadata goes first, so a profile is never listed with half a
// directory; a directory that then fails to go away is reported, and is
// unreachable since no profile names it any more.
func (s *Store) Remove(agent session.AgentType, id string) error {
	dir, err := s.Dir(agent, id)
	if err != nil {
		return err
	}
	err = s.update(agent, func(l *List) error {
		i := l.index(id)
		if i < 0 {
			return fmt.Errorf("%w: %q", ErrNotFound, id)
		}
		l.Profiles = slices.Delete(l.Profiles, i, i+1)
		if l.Current == id {
			l.Current = ""
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("remove directory of profile %q: %w", id, err)
	}
	return nil
}

// update is a read-modify-write of agent's list under the file's lock, so
// changes from other processes are never overwritten. The directory is
// restricted first: profile directories hold credentials, and on Windows only
// the parent's ACL protects them (see fsperm).
func (s *Store) update(agent session.AgentType, change func(*List) error) error {
	if !agent.IsValid() {
		return fmt.Errorf("%w: %q", ErrUnsupportedAgent, agent)
	}
	if err := fsperm.RestrictDir(filepath.Dir(s.path)); err != nil {
		return err
	}
	apply := func(old []byte) ([]byte, error) {
		var f file
		if old != nil && json.Unmarshal(old, &f) != nil {
			return nil, errDamaged
		}
		if f == nil {
			// No file, or one holding a JSON null.
			f = file{}
		}
		list := f.list(agent)
		if err := change(&list); err != nil {
			return nil, err
		}
		if len(list.Profiles) == 0 && list.Current == "" {
			delete(f, agent)
		} else {
			f[agent] = &list
		}
		return filestore.MarshalIndex(f)
	}

	err := filestore.UpdateFileAtomic(s.path, 0600, apply)
	if !errors.Is(err, errDamaged) {
		return err
	}
	// Quarantining needs the lock the update held, so it happens between two
	// attempts; Load is what quarantines.
	if _, err := s.Load(agent); err != nil {
		return err
	}
	return filestore.UpdateFileAtomic(s.path, 0600, apply)
}

// list copies agent's stored list. A current ID naming no profile — the file
// is the user's to edit — reads as the default profile, as Current reports it.
func (f file) list(agent session.AgentType) List {
	l := List{Profiles: []Profile{}}
	if stored := f[agent]; stored != nil {
		l.Profiles = append(l.Profiles, stored.Profiles...)
		if l.index(stored.Current) >= 0 {
			l.Current = stored.Current
		}
	}
	return l
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > MaxNameLength || strings.ContainsFunc(name, unicode.IsControl) {
		return "", ErrInvalidName
	}
	return name, nil
}

// nameTaken compares case-insensitively: two profiles a user can tell apart
// only by case would be picked by mistake.
func nameTaken(l *List, name, exceptID string) bool {
	return slices.ContainsFunc(l.Profiles, func(p Profile) bool {
		return p.ID != exceptID && strings.EqualFold(p.Name, name)
	})
}

func validID(id string) bool {
	parsed, err := uuid.Parse(id)
	return err == nil && parsed.String() == id
}
