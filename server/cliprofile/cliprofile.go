// Package cliprofile keeps the accounts (profiles) registered for each AI CLI,
// and which one this Pockode server runs each CLI as.
//
// The list is cli-profiles.json in the OS user's configuration directory, next
// to cloudcred's cloud.json and for the same reason — every Pockode process the
// OS user runs, servers in different projects, a cluster and the nodes it
// starts, reads and changes the same list. The choice of the current profile is
// not shared: each server keeps its own in its data directory, so switching
// accounts in one changes what no other runs as.
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
	// ErrNoStore is a change asked of the nil Store: Pockode found no
	// configuration directory, so there is only the default profile.
	ErrNoStore = errors.New("no configuration directory was found to keep AI CLI profiles in")
	// ErrDirectoryLeft is a profile Remove took off the list but whose
	// directory it could not delete: the profile is gone, the files are not.
	ErrDirectoryLeft = errors.New("the profile was removed, but its directory could not be deleted")
)

// errDamaged is a file that failed to parse while a change held its lock; the
// change quarantines it and retries over the empty list.
var errDamaged = errors.New("profile file is damaged")

type Profile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// List is one CLI's profiles. Current is the ID of the profile this server has
// chosen, or "" for the default one; it is never stored with the profiles.
type List struct {
	Current  string
	Profiles []Profile
}

func (l *List) index(id string) int {
	return slices.IndexFunc(l.Profiles, func(p Profile) bool { return p.ID == id })
}

// file is the stored list. A CLI with no profiles is absent rather than stored
// empty.
//
// Before the choice was per server, each CLI's entry also had a "current", the
// one choice every Pockode process followed. It is not carried over to anyone:
// reading ignores it, and the next change to the list drops it from the file —
// so a process of an older version still running, a cluster node not yet
// restarted, is moved to the default profile by that change.
type file map[session.AgentType]*storedList

type storedList struct {
	Profiles []Profile `json:"profiles"`
}

// choices is this server's choice of each CLI's current profile. A CLI it has
// made no choice for, or chose the default profile for, is absent.
type choices map[session.AgentType]string

type Store struct {
	path    string
	baseDir string
	// choicePath is this server's own file, in its data directory: what it
	// runs each CLI as.
	choicePath string

	availabilityOnce sync.Once
	availability     Availability
	// unavailableWarning logs, once, that the current profile is passed over
	// because profiles cannot be used here.
	unavailableWarning sync.Once

	local local
}

// DefaultStore is the list every Pockode process of this OS user shares, with
// the choice of the server whose data directory is dataDir.
func DefaultStore(dataDir string) (*Store, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return NewStore(configDir, dataDir), nil
}

// NewStore keeps cli-profiles.json, and the profile directories under
// cli-profiles/, in configDir/pockode, and this server's choice of current
// profiles in dataDir — a project's server's, or a cluster node's, which is
// one too.
func NewStore(configDir, dataDir string) *Store {
	dir := filepath.Join(configDir, "pockode")
	return &Store{
		path:       filepath.Join(dir, "cli-profiles.json"),
		baseDir:    filepath.Join(dir, "cli-profiles"),
		choicePath: filepath.Join(dataDir, "current-cli-profiles.json"),
	}
}

// Dir is where the profile id of agent keeps its CLI directory — the value of
// CLAUDE_CONFIG_DIR or CODEX_HOME when it is current. It only computes the
// path: nothing is created, and id is not looked up. The id is checked to be
// one this package could have issued, since it ends up in a path and may come
// from a client.
func (s *Store) Dir(agent session.AgentType, id string) (string, error) {
	if s == nil {
		return "", ErrNoStore
	}
	if !agent.IsValid() {
		return "", fmt.Errorf("%w: %q", ErrUnsupportedAgent, agent)
	}
	if !validID(id) {
		return "", fmt.Errorf("%w: %q", ErrNotFound, id)
	}
	return filepath.Join(s.baseDir, string(agent), id), nil
}

// Load returns agent's profiles and this server's choice among them. No file,
// or a damaged one that had to be quarantined, is an empty list, and so is
// every list of the nil Store; no choice, a damaged one, or one naming a
// profile no longer listed is the default profile.
func (s *Store) Load(agent session.AgentType) (List, error) {
	l, err := s.loadList(agent)
	if err != nil || len(l.Profiles) == 0 {
		return l, err
	}
	var c choices
	found, err := filestore.ReadJSONOrQuarantine(s.choicePath, "current AI CLI profiles", &c)
	if err != nil {
		return List{}, err
	}
	if found && l.index(c[agent]) >= 0 {
		l.Current = c[agent]
	}
	return l, nil
}

// loadList is Load without this server's choice, for what only asks which
// profiles there are.
func (s *Store) loadList(agent session.AgentType) (List, error) {
	if !agent.IsValid() {
		return List{}, fmt.Errorf("%w: %q", ErrUnsupportedAgent, agent)
	}
	if s == nil {
		return List{Profiles: []Profile{}}, nil
	}
	var f file
	found, err := filestore.ReadJSONOrQuarantine(s.path, "AI CLI profiles", &f)
	if err != nil || !found {
		return List{Profiles: []Profile{}}, err
	}
	return f.list(agent), nil
}

// Current returns agent's current profile on this server, or nil for the
// default one.
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

// SetCurrent makes the profile id current for agent on this server; "" makes
// it the default one. No other Pockode process follows it.
//
// It is not refused where Availability says profiles cannot be used: the CLIs
// keep running as the default profile there (Resolve), and the choice takes
// effect once this server restarts on a machine that allows symbolic links —
// what the unavailable reason tells the user to do.
//
// The profile is looked up before the choice is written, under two different
// locks: a removal by another process landing in between leaves a choice
// naming no profile, which reads as the default one.
func (s *Store) SetCurrent(agent session.AgentType, id string) error {
	if !agent.IsValid() {
		return fmt.Errorf("%w: %q", ErrUnsupportedAgent, agent)
	}
	if s == nil {
		return ErrNoStore
	}
	if id != "" {
		if err := s.requireListed(agent, id); err != nil {
			return err
		}
	}
	apply := func(old []byte) ([]byte, error) {
		var c choices
		if old != nil && json.Unmarshal(old, &c) != nil {
			return nil, errDamaged
		}
		if c == nil {
			c = choices{}
		}
		if c[agent] == id {
			return nil, nil
		}
		if id == "" {
			delete(c, agent)
		} else {
			c[agent] = id
		}
		return filestore.MarshalIndex(c)
	}
	err := filestore.UpdateFileAtomic(s.choicePath, 0600, apply)
	if !errors.Is(err, errDamaged) {
		return err
	}
	var discard choices
	if _, err := filestore.ReadJSONOrQuarantine(s.choicePath, "current AI CLI profiles", &discard); err != nil {
		return err
	}
	return filestore.UpdateFileAtomic(s.choicePath, 0600, apply)
}

// Remove forgets the profile id and deletes its directory, with whatever
// credentials are in it; the links in it are removed, never followed. A
// server that had it as its current profile — this one or any other — reads
// the default one as current from then on, its choice naming no profile; the
// stale choice is left in its file, harmless since IDs are never reused.
//
// Credentials kept outside the directory are not touched: Claude Code on
// macOS keeps them in a Keychain item named after the directory, so a caller
// signs the profile out first. Nor does it stop a CLI still running as the
// profile, which would recreate the directory; the caller sees to that too.
//
// The metadata goes first, so a profile is never listed with half a
// directory; a directory that then fails to go away is ErrDirectoryLeft, and
// is unreachable since no profile names it any more.
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
		return nil
	})
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("%w: %s: %w", ErrDirectoryLeft, dir, err)
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
	if s == nil {
		return ErrNoStore
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
		if len(list.Profiles) == 0 {
			delete(f, agent)
		} else {
			f[agent] = &storedList{Profiles: list.Profiles}
		}
		return filestore.MarshalIndex(f)
	}

	err := filestore.UpdateFileAtomic(s.path, 0600, apply)
	if !errors.Is(err, errDamaged) {
		return err
	}
	// Quarantining needs the lock the update held, so it happens between two
	// attempts; Load is what quarantines.
	if _, err := s.loadList(agent); err != nil {
		return err
	}
	return filestore.UpdateFileAtomic(s.path, 0600, apply)
}

// list copies agent's stored list, with no choice made.
func (f file) list(agent session.AgentType) List {
	l := List{Profiles: []Profile{}}
	if stored := f[agent]; stored != nil {
		l.Profiles = append(l.Profiles, stored.Profiles...)
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
