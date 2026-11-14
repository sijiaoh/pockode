package cliprofile

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"

	"github.com/pockode/server/filestore"
	"github.com/pockode/server/internal/fsperm"
	"github.com/pockode/server/internal/pathutil"
	"github.com/pockode/server/session"
)

// ErrSymlinksUnavailable is Prepare refusing on a machine that cannot create
// the links a profile directory is made of; Availability says why.
var ErrSymlinksUnavailable = errors.New("only the default profile is available on this machine")

// layout is what of a CLI's directory a profile keeps to itself and what it
// must share.
type layout struct {
	envVar  string
	homeDir string
	// shared must be links whether or not the default directory has them yet:
	// without them an existing session cannot be resumed under the profile, or
	// two profiles write the same thread at once. Their targets are created in
	// the default directory first, because a CLI creating something under a
	// dangling link fails outright.
	shared []string
	// private are filepath.Match patterns for the entries a profile keeps to
	// itself; everything else in the default directory is linked. A denylist
	// rather than an allowlist: CLI updates keep adding state, and an
	// allowlist would silently leave the new piece unshared.
	private []string
	// launchEnv are further variables a non-default profile is started with,
	// each set to its directory as envVar is; see Launch.
	launchEnv []string
	// launchArgs are the options a non-default profile is started with.
	launchArgs []string
}

var layouts = map[session.AgentType]layout{
	session.AgentTypeClaude: {
		envVar:  "CLAUDE_CONFIG_DIR",
		homeDir: ".claude",
		shared:  []string{"projects"},
		// With a * because credentials come with side files — a lock, a temp
		// file renamed over the original, older versions' backups — and one
		// caught by Prepare would otherwise be linked, credentials and all.
		private: []string{".credentials.json*", ".claude.json*", "sessions", "backups"},
		// On macOS the credentials are not in .credentials.json but in a
		// Keychain item, which Claude Code (2.1.325) names after the
		// directory this variable gives, falling back to CLAUDE_CONFIG_DIR —
		// and to the default profile's item when it is set but empty. Set
		// explicitly, so that one inherited from the environment Pockode was
		// started in cannot make every profile share the default's item.
		launchEnv: []string{"CLAUDE_SECURESTORAGE_CONFIG_DIR"},
	},
	session.AgentTypeCodex: {
		envVar:  "CODEX_HOME",
		homeDir: ".codex",
		shared:  []string{"sessions", "thread-writer-locks"},
		// logs_*.sqlite* rather than logs_*.sqlite: a SQLite database is its
		// -wal and -shm files as well, and sharing them while the database
		// stays private corrupts both copies.
		private: append([]string{"auth.json", "auth.json.lock", "auth.lock", "logs_*.sqlite*", "tmp", ".tmp", "shell_snapshots"},
			codexPlatformPrivate...),
		// Credentials in auth.json, which is private, rather than in the OS
		// keyring, whose entry a profile could share with the default. As an
		// override, because config.toml is linked: setting it there would set
		// it for every profile, the default one included. The value bare
		// rather than as a TOML string ("file"), which codex takes as the same
		// thing: an argument with a double quote cannot be passed through the
		// .cmd wrapper an npm install has on Windows (agent/cmdline.go).
		launchArgs: []string{"-c", "cli_auth_credentials_store=file"},
	},
}

func layoutOf(agent session.AgentType) (layout, error) {
	l, ok := layouts[agent]
	if !ok {
		return layout{}, fmt.Errorf("%w: %q", ErrUnsupportedAgent, agent)
	}
	return l, nil
}

func (l layout) isPrivate(name string) bool {
	return slices.ContainsFunc(l.private, func(pattern string) bool {
		ok, _ := filepath.Match(pattern, name)
		return ok
	})
}

// DefaultDir is agent's default profile: the CLAUDE_CONFIG_DIR or CODEX_HOME
// Pockode was started with, or ~/.claude or ~/.codex. Pockode never sets these
// variables in its own environment — only in the CLIs it starts — so this
// stays the user's directory.
func DefaultDir(agent session.AgentType) (string, error) {
	l, err := layoutOf(agent)
	if err != nil {
		return "", err
	}
	if dir := os.Getenv(l.envVar); dir != "" {
		return filepath.Abs(dir)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// A relative directory would be the server's working directory.
		return "", fmt.Errorf("locate the default %s directory: %w", agent, err)
	}
	return filepath.Join(home, l.homeDir), nil
}

// Conflict is an entry of a profile directory that should be a link into the
// default directory but is not: a real file or directory, one the CLI created
// there before the default directory had it, or a link into another directory
// that still exists — another Pockode process of this user started with a
// different CLAUDE_CONFIG_DIR / CODEX_HOME. Whatever it holds is not shared
// with this default directory until the user resolves it. Pockode never moves
// a real entry, since the CLI may have it open (moving a SQLite database in
// use splits it from its WAL), and never repoints a live link, which would
// move a running CLI's files from under it.
type Conflict struct {
	Name string
	Path string
}

// testHookLinked runs in Prepare once the directory is filled in, so a test can
// remove the profile at the moment that matters.
var testHookLinked func()

// Prepare makes the directory of agent's profile id ready to start the CLI
// with: credentials are its own, everything else links into the default
// directory. It only changes what is missing or wrong, so it is meant to run
// before every start of the CLI, picking up what the default directory has
// gained since.
//
// Every symlink in a profile directory is Pockode's, and one that dangles —
// the default directory was moved or lost the entry — or whose name has
// become private is replaced or removed; removing a link loses no data. Real
// files and directories, and links to anything that exists, are never
// touched: the ones that should have been links are returned, and logged,
// rather than failing — the profile still works, it only does not share them.
func (s *Store) Prepare(agent session.AgentType, id string) ([]Conflict, error) {
	l, err := layoutOf(agent)
	if err != nil {
		return nil, err
	}
	dir, err := s.Dir(agent, id)
	if err != nil {
		return nil, err
	}
	if a := s.Availability(); !a.Available {
		return nil, fmt.Errorf("%w: %s", ErrSymlinksUnavailable, a.Reason)
	}
	if err := s.requireListed(agent, id); err != nil {
		return nil, err
	}
	defaultDir, err := DefaultDir(agent)
	if err != nil {
		return nil, err
	}

	// The directory holds credentials; on Windows only the parent's ACL
	// protects it (see fsperm).
	if err := fsperm.RestrictDir(filepath.Dir(s.path)); err != nil {
		return nil, err
	}
	// Pockode started from inside a CLI running on a profile inherits that
	// profile's directory as its default; linking it into another profile
	// would chain profiles together instead of sharing the user's directory.
	if _, inside := pathutil.ChildName(resolve(defaultDir), resolve(s.baseDir)); inside {
		return nil, fmt.Errorf("the default %s directory %s is a profile directory: start Pockode without %s set to it", agent, defaultDir, l.envVar)
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create directory of profile %q: %w", id, err)
	}
	for _, name := range l.shared {
		if err := os.MkdirAll(filepath.Join(defaultDir, name), 0o700); err != nil {
			return nil, fmt.Errorf("create shared %s directory: %w", agent, err)
		}
	}

	p, err := plan(l, dir, defaultDir)
	if err != nil {
		return nil, err
	}
	for _, name := range p.unlink {
		if err := unlink(filepath.Join(dir, name), l.isPrivate(name)); err != nil {
			return nil, fmt.Errorf("remove link %q of profile %q: %w", name, id, err)
		}
	}
	for _, name := range p.link {
		path := filepath.Join(dir, name)
		err := link(filepath.Join(defaultDir, name), path)
		if errors.Is(err, fs.ErrExist) {
			// Something else got there since plan looked: the profile's CLI
			// creating the entry itself.
			p.conflicts = append(p.conflicts, Conflict{Name: name, Path: path})
		} else if err != nil {
			return nil, fmt.Errorf("link %q into profile %q: %w", name, id, err)
		}
	}
	for _, c := range p.conflicts {
		slog.Warn("AI CLI profile has its own copy of an entry it should share; leaving it in place",
			"agent", agent, "profile", id, "path", c.Path)
	}
	if testHookLinked != nil {
		testHookLinked()
	}

	// Remove deletes the directory after dropping the profile, outside the
	// lock: if it ran while this was filling the directory in, the directory
	// may have come back. Checking again afterwards closes that window — a
	// Remove after this check deletes what was created before it.
	listed, err := s.stillListed(agent, id)
	if err != nil {
		return nil, err
	}
	if !listed {
		if err := os.RemoveAll(dir); err != nil {
			return nil, fmt.Errorf("remove directory of removed profile %q: %w", id, err)
		}
		return nil, fmt.Errorf("%w: %q", ErrNotFound, id)
	}
	return p.conflicts, nil
}

// Conflicts reports what Prepare would report for the profile id, without
// changing anything. A profile never prepared has none.
func (s *Store) Conflicts(agent session.AgentType, id string) ([]Conflict, error) {
	l, err := layoutOf(agent)
	if err != nil {
		return nil, err
	}
	dir, err := s.Dir(agent, id)
	if err != nil {
		return nil, err
	}
	defaultDir, err := DefaultDir(agent)
	if err != nil {
		return nil, err
	}
	p, err := plan(l, dir, defaultDir)
	if err != nil {
		return nil, err
	}
	return p.conflicts, nil
}

func (s *Store) requireListed(agent session.AgentType, id string) error {
	list, err := s.Load(agent)
	if err != nil {
		return err
	}
	if list.index(id) < 0 {
		return fmt.Errorf("%w: %q", ErrNotFound, id)
	}
	return nil
}

// stillListed answers only from a file that parses. Its "no" deletes a
// directory full of credentials, so a file damaged by hand, or gone, is an
// error rather than the empty list Load would make of it.
func (s *Store) stillListed(agent session.AgentType, id string) (bool, error) {
	data, err := filestore.ReadFileLocked(s.path)
	if err != nil {
		return false, err
	}
	if data == nil {
		return false, fmt.Errorf("%s disappeared while profile %q was being prepared", s.path, id)
	}
	var f file
	if err := json.Unmarshal(data, &f); err != nil {
		return false, fmt.Errorf("read %s: %w", s.path, err)
	}
	list := f.list(agent)
	return list.index(id) >= 0, nil
}

type preparation struct {
	// unlink are links to remove; a name also in link is replaced.
	unlink    []string
	link      []string
	conflicts []Conflict
}

// plan compares the profile directory dir with defaultDir. A missing dir is
// an empty one.
func plan(l layout, dir, defaultDir string) (preparation, error) {
	var p preparation

	want, err := wantedLinks(l, defaultDir)
	if err != nil {
		return p, err
	}
	have, err := readDirNames(dir)
	if err != nil {
		return p, fmt.Errorf("read profile directory: %w", err)
	}

	for _, name := range want {
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			p.link = append(p.link, name)
		case err != nil:
			return p, err
		case isSymlink(info) && pointsAt(path, filepath.Join(defaultDir, name)):
		case isSymlink(info) && dangles(path):
			p.unlink = append(p.unlink, name)
			p.link = append(p.link, name)
		default:
			p.conflicts = append(p.conflicts, Conflict{Name: name, Path: path})
		}
	}

	for _, name := range have {
		if slices.Contains(want, name) {
			continue
		}
		info, err := os.Lstat(filepath.Join(dir, name))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return p, err
		}
		if err == nil && isSymlink(info) && (l.isPrivate(name) || dangles(filepath.Join(dir, name))) {
			p.unlink = append(p.unlink, name)
		}
	}
	return p, nil
}

// wantedLinks are the names that should link into defaultDir: the shared ones
// and everything defaultDir has that is not private.
func wantedLinks(l layout, defaultDir string) ([]string, error) {
	names, err := readDirNames(defaultDir)
	if err != nil {
		return nil, fmt.Errorf("read default directory: %w", err)
	}
	want := slices.Clone(l.shared)
	for _, name := range names {
		if !l.isPrivate(name) && !slices.Contains(want, name) {
			want = append(want, name)
		}
	}
	return want, nil
}

func readDirNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	return names, nil
}

func isSymlink(info fs.FileInfo) bool { return info.Mode()&fs.ModeSymlink != 0 }

func dangles(link string) bool {
	_, err := os.Stat(link)
	return errors.Is(err, fs.ErrNotExist)
}

func pointsAt(link, target string) bool {
	got, err := os.Readlink(link)
	return err == nil && pathutil.Equal(filepath.Clean(got), filepath.Clean(target))
}

// unlink removes the symlink at path — plan's verdict, which may be stale by
// now, so it looks again first. A CLI writing through the link by temp file and
// rename may have put a real file there, which is the profile's data. And a
// link removed for dangling may have been replaced by another Prepare of the
// same profile — every CLI start runs one — with a link that works, which the
// CLI that Prepare is starting is about to use; only a private name goes
// whatever it points at.
func unlink(path string, private bool) error {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !isSymlink(info) || (!private && !dangles(path)) {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// link creates linkPath pointing at target. Another process preparing the same
// profile may have created it first; that is success when its link is the
// same one.
func link(target, linkPath string) error {
	err := os.Symlink(target, linkPath)
	if errors.Is(err, fs.ErrExist) && pointsAt(linkPath, target) {
		return nil
	}
	return err
}

// resolve follows the symlinks in path — in its nearest existing ancestor,
// since a profile directory may not exist yet — so two spellings of one
// directory compare equal.
func resolve(path string) string {
	rest := ""
	for dir := path; ; dir = filepath.Dir(dir) {
		if r, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(r, rest)
		}
		if filepath.Dir(dir) == dir {
			return path
		}
		rest = filepath.Join(filepath.Base(dir), rest)
	}
}
