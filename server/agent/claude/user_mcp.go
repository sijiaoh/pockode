package claude

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/internal/pathutil"
	"github.com/pockode/server/session"
)

// globalConfigFile is the file Claude keeps its account, per-project state and
// user-scope MCP servers (`claude mcp add -s user`) in.
const globalConfigFile = ".claude.json"

// defaultGlobalConfigPath is the default profile's globalConfigFile. Claude
// keeps it inside CLAUDE_CONFIG_DIR when that is set, and otherwise beside
// ~/.claude rather than in it — DefaultDir is then ~/.claude, so its parent is
// the home directory.
func defaultGlobalConfigPath() (string, error) {
	dir, err := cliprofile.DefaultDir(session.AgentTypeClaude)
	if err != nil {
		return "", err
	}
	if os.Getenv("CLAUDE_CONFIG_DIR") != "" {
		return filepath.Join(dir, globalConfigFile), nil
	}
	return filepath.Join(filepath.Dir(dir), globalConfigFile), nil
}

// mcpServersFile is a config file of Claude's as far as MCP servers go:
// globalConfigFile, whose top level is the user scope and whose projects hold
// the local scope (`claude mcp add`'s default), and a project's .mcp.json.
// Projects is left undecoded: it is only ever needed from the profile's own
// file, and a local-scope entry of a shape this does not expect must not cost
// the user every server they have.
type mcpServersFile struct {
	MCPServers map[string]json.RawMessage `json:"mcpServers"`
	Projects   json.RawMessage            `json:"projects"`
}

// projectMCPFile is the project scope, read by Claude from the directory it
// runs in and every directory above it.
const projectMCPFile = ".mcp.json"

// userMCPServers is the package's userMCPServers for profileID, "" being the
// default profile, which gets none.
func (a *Agent) userMCPServers(ctx context.Context, profileID, workDir string, log *slog.Logger) (map[string]json.RawMessage, error) {
	if profileID == "" {
		return nil, nil
	}
	profileDir, err := a.profiles.Dir(session.AgentTypeClaude, profileID)
	if err != nil {
		return nil, err
	}
	return userMCPServers(ctx, profileDir, workDir, log)
}

// readMCPServersFile reads path, a missing file being an empty one. A plain
// read, no lock: Claude replaces its own files by rename, so this sees one
// whole version or the other, and a lock would create a .lock beside a file
// that is not Pockode's.
func readMCPServersFile(path string) (mcpServersFile, error) {
	var file mcpServersFile
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return file, err
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return file, fmt.Errorf("parse %s: %w", path, err)
	}
	return file, nil
}

// userMCPServers is the user-scope MCP servers a CLI running as the profile in
// profileDir, in workDir, has to be given on the command line, keyed by name
// and left as Claude wrote them.
//
// globalConfigFile is private to a profile — it holds the signed-in account —
// so a CLI running as another profile reads its own, empty one, and the
// servers the user added under the default profile would be gone the moment
// they switched accounts. They are read from the default profile's file and
// handed over with --mcp-config instead. Never written into the profile's own
// file: Claude rewrites that one whenever it likes, and the two writers would
// race.
//
// --mcp-config outranks every scope Claude reads itself (measured on claude
// 2.1.325: a server named in it replaces a local-scope one of the same name).
// So a server is left out where a scope that outranks the user's, or the
// profile's own user scope, has one of its name: Claude starts that one, as it
// would on the default profile. That is why the default profile gets nothing
// at all, too — Claude reads its user scope itself, and given here as well it
// would override the user's project and local servers.
//
// A missing default file is no servers — a user who never ran Claude here has
// none. One that cannot be read or parsed is an error.
func userMCPServers(ctx context.Context, profileDir, workDir string, log *slog.Logger) (map[string]json.RawMessage, error) {
	path, err := defaultGlobalConfigPath()
	if err != nil {
		return nil, err
	}
	file, err := readMCPServersFile(path)
	if err != nil {
		return nil, err
	}
	servers := file.MCPServers
	if len(servers) == 0 {
		return nil, nil
	}
	shadowed := shadowingScopes(ctx, profileDir, workDir, log)
	for name := range servers {
		if shadowed[name] {
			log.Info("a user-scope MCP server is defined again where Claude gives it precedence; leaving Claude's", "name", name)
			delete(servers, name)
		}
	}
	return servers, nil
}

// shadowingScopes is the names of the MCP servers Claude reads itself, in
// workDir as the profile in profileDir, that are to win over the default
// profile's user scope: the profile's own user scope, its local scope, and the
// project scope. A file among them that cannot be read is Claude's to report —
// it reads every one of them itself — so it only costs this check its names.
//
// The local scope is the one entry of the profile's projects that Claude keys
// workDir by — see localScopeKeys.
func shadowingScopes(ctx context.Context, profileDir, workDir string, log *slog.Logger) map[string]bool {
	names := map[string]bool{}
	add := func(servers map[string]json.RawMessage) {
		for name := range servers {
			names[name] = true
		}
	}

	profileFile, err := readMCPServersFile(filepath.Join(profileDir, globalConfigFile))
	if err != nil {
		log.Warn("could not read the profile's own MCP servers; the user's may override them", "error", err)
	}
	add(profileFile.MCPServers)
	var projects map[string]json.RawMessage
	if len(profileFile.Projects) > 0 {
		if err := json.Unmarshal(profileFile.Projects, &projects); err != nil {
			log.Warn("could not read the profile's local-scope MCP servers; the user's may override them", "error", err)
		}
	}

	// Claude keys and searches by the directory's real path.
	workDir = realPath(workDir)
	if len(projects) > 0 {
		keys := localScopeKeys(ctx, workDir, log)
		for key, raw := range projects {
			if !slices.ContainsFunc(keys, func(k string) bool { return pathutil.Equal(filepath.FromSlash(key), k) }) {
				continue
			}
			var local mcpServersFile
			if err := json.Unmarshal(raw, &local); err != nil {
				log.Warn("could not read the profile's local-scope MCP servers; the user's may override them", "project", key, "error", err)
			}
			add(local.MCPServers)
		}
	}
	for dir := workDir; ; dir = filepath.Dir(dir) {
		project, err := readMCPServersFile(filepath.Join(dir, projectMCPFile))
		if err != nil {
			log.Warn("could not read a project's MCP servers; the user's may override them", "error", err)
		}
		add(project.MCPServers)
		if filepath.Dir(dir) == dir {
			return names
		}
	}
}

// gitRootTimeout bounds the one `git rev-parse` localScopeKeys runs, which
// reads a few files under .git; one that takes longer is not worth holding a
// session's start for.
const gitRootTimeout = 10 * time.Second

// localScopeKeys is the directories whose entry in a profile's projects Claude
// takes the local scope from in workDir, a real path.
//
// Measured on claude 2.1.325, which works this out from the files under .git
// rather than by asking git: outside a repository the key is workDir itself
// and nothing above it; in a main worktree, anywhere inside it, it is the
// worktree's top level; in a linked worktree it is the main one's — the parent
// of the common git directory, or the common directory itself when that is not
// named .git (a bare repository, or one cloned with --separate-git-dir). That
// last case is why a linked worktree is told apart by its git directory rather
// than by --show-toplevel: Pockode makes its worktrees beside the repository,
// in <repo>-worktrees, so nothing about where they sit leads back to it.
//
// When git cannot answer — not installed, a repository it refuses to read, too
// slow — the key cannot be known. Every directory from workDir up is counted
// then, which still finds a main worktree's key from inside it, and the miss
// is logged: the session starts either way, at worst with a user server
// standing in for the profile's own local one.
func localScopeKeys(ctx context.Context, workDir string, log *slog.Logger) []string {
	root, err := claudeProjectRoot(ctx, workDir)
	if err == nil {
		return []string{root}
	}
	log.Warn("could not tell which project Claude keys this directory's local-scope MCP servers by; matching every directory above it, so the user's servers may override the profile's own", "dir", workDir, "error", err)
	var keys []string
	for dir := workDir; ; dir = filepath.Dir(dir) {
		keys = append(keys, dir)
		if filepath.Dir(dir) == dir {
			return keys
		}
	}
}

// claudeProjectRoot is localScopeKeys' answer for workDir as git gives it.
func claudeProjectRoot(ctx context.Context, workDir string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitRootTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "rev-parse", "--absolute-git-dir", "--git-common-dir", "--show-toplevel")
	cmd.Dir = workDir
	cmd.Env = gitDiscoveryEnv()
	// Output waits for the pipes, which a child git left behind could hold
	// open past the timeout.
	cmd.WaitDelay = time.Second
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		// Only the search coming up empty: a .git that is there but leads
		// nowhere (a pruned worktree) says "not a git repository: <path>",
		// and what Claude keys that by is not known.
		if strings.Contains(stderr.String(), "not a git repository (or any") {
			return workDir, nil
		}
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return "", fmt.Errorf("git rev-parse: %w: %s", err, msg)
		}
		return "", fmt.Errorf("git rev-parse: %w", err)
	}
	lines := strings.Split(strings.TrimRight(string(out), "\r\n"), "\n")
	if len(lines) != 3 {
		return "", fmt.Errorf("git rev-parse printed %q, want three paths", out)
	}
	native := func(p string) string {
		p = filepath.FromSlash(strings.TrimRight(p, "\r"))
		if !filepath.IsAbs(p) {
			// --git-common-dir is relative to workDir in a main worktree.
			p = filepath.Join(workDir, p)
		}
		return realPath(p)
	}
	gitDir, commonDir, topLevel := native(lines[0]), native(lines[1]), native(lines[2])
	if pathutil.Equal(gitDir, commonDir) {
		return topLevel, nil
	}
	if filepath.Base(commonDir) == ".git" {
		return filepath.Dir(commonDir), nil
	}
	return commonDir, nil
}

// gitDiscoveryEnv is the environment for git to find workDir's repository as
// Claude does, by reading the .git files from it upwards and nothing else:
// none of the server's own GIT_* variables (a GIT_DIR pointing elsewhere, a
// ceiling stopping the search), no stop at a filesystem boundary, and git's
// messages in English so the empty search can be recognised.
func gitDiscoveryEnv() []string {
	env := slices.DeleteFunc(os.Environ(), func(kv string) bool {
		return strings.HasPrefix(strings.ToUpper(kv), "GIT_")
	})
	return append(env, "GIT_DISCOVERY_ACROSS_FILESYSTEM=1", "LC_ALL=C", "LANGUAGE=")
}

// realPath is path with its symlinks resolved, as Claude keys and searches by
// it, or path as it is when that fails.
func realPath(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}

// userMCPServersWarning tells the user why a session running as another
// profile came up without their user-scope MCP servers.
//
// The session starts anyway: the file is the user's, a damaged one would
// otherwise stop every session on the profile until they found and fixed it,
// and the work Pockode drives needs only its own server.
func userMCPServersWarning(err error) agent.WarningEvent {
	return agent.WarningEvent{
		Message: fmt.Sprintf("Claude is running as another account here, and Pockode could not read the MCP servers you added for all projects from the default account's configuration (%v), so this session starts without them.", err),
		Code:    "user_mcp_servers_unavailable",
	}
}
