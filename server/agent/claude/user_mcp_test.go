package claude

import (
	"encoding/json"
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliprofile/cliprofiletest"
	"github.com/pockode/server/filestore"
	"github.com/pockode/server/internal/pathutil"
	"github.com/pockode/server/session"
)

const userServersConfig = `{
  "oauthAccount": {"emailAddress": "someone@example.com"},
  "mcpServers": {
    "docs": {"type": "http", "url": "https://docs.example.com/mcp", "headers": {"Authorization": "Bearer x"}},
    "tool": {"command": "tool-mcp", "args": ["--flag"], "env": {"KEY": "v"}}
  }
}`

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := filestore.WriteFileAtomic(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func writeDefaultGlobalConfig(t *testing.T, content string) string {
	t.Helper()
	path, err := defaultGlobalConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, content)
	return path
}

// serversOf is what a CLI running as profileID in workDir is handed.
func serversOf(t *testing.T, f *cliprofiletest.Fixture, profileID, workDir string) map[string]json.RawMessage {
	t.Helper()
	servers, err := New(f.Store).userMCPServers(t.Context(), profileID, workDir, slog.Default())
	if err != nil {
		t.Fatalf("userMCPServers: %v", err)
	}
	return servers
}

// A CLI running as another profile is handed the default profile's user-scope
// servers as they are; the default profile is handed none, since Claude reads
// them itself.
func TestUserMCPServers(t *testing.T) {
	f := cliprofiletest.New(t)
	writeDefaultGlobalConfig(t, userServersConfig)

	if servers := serversOf(t, f, "", t.TempDir()); servers != nil {
		t.Errorf("default profile: %v; want none", servers)
	}

	id, _ := f.UseProfile(t, session.AgentTypeClaude)
	servers := serversOf(t, f, id, t.TempDir())
	var want mcpServersFile
	if err := json.Unmarshal([]byte(userServersConfig), &want); err != nil {
		t.Fatal(err)
	}
	if !maps.EqualFunc(servers, want.MCPServers, func(a, b json.RawMessage) bool { return string(a) == string(b) }) {
		t.Errorf("servers = %s, want %s unchanged", servers, want.MCPServers)
	}
}

// --mcp-config outranks every scope Claude reads itself, so a user server is
// left out wherever a scope that should win over it has one of its name — as
// it would lose on the default profile.
func TestUserMCPServers_LeavesOutShadowed(t *testing.T) {
	f := cliprofiletest.New(t)
	writeDefaultGlobalConfig(t, `{"mcpServers": {"own": {}, "local": {}, "project": {}, "elsewhere": {}, "kept": {}}}`)
	id, profileDir := f.UseProfile(t, session.AgentTypeClaude)

	parent := t.TempDir()
	workDir := filepath.Join(parent, "work")
	if err := os.Mkdir(workDir, 0755); err != nil {
		t.Fatal(err)
	}
	realWork, err := filepath.EvalSymlinks(workDir)
	if err != nil {
		t.Fatal(err)
	}
	profileConfig, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{"own": map[string]any{}},
		"projects": map[string]any{
			filepath.ToSlash(realWork):    map[string]any{"mcpServers": map[string]any{"local": map[string]any{}}},
			filepath.ToSlash(t.TempDir()): map[string]any{"mcpServers": map[string]any{"elsewhere": map[string]any{}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(profileDir, globalConfigFile), string(profileConfig))
	// Above the work directory: Claude reads every .mcp.json on the way up.
	writeFile(t, filepath.Join(parent, projectMCPFile), `{"mcpServers": {"project": {}}}`)

	got := slices.Sorted(maps.Keys(serversOf(t, f, id, workDir)))
	if want := []string{"elsewhere", "kept"}; !slices.Equal(got, want) {
		t.Errorf("servers = %v, want %v", got, want)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	// Not the repository a hook running the tests may have exported.
	cmd.Env = gitDiscoveryEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func mkdir(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

// The key Claude takes a directory's local scope from, each as measured on
// claude 2.1.325 with `claude mcp add -s local`. Among them a worktree made
// beside the repository, where Pockode makes them: nothing about where it
// sits leads back to the main worktree whose key it uses.
func TestClaudeProjectRoot(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	base := mkdir(t, t.TempDir())
	plain := mkdir(t, filepath.Join(base, "plain", "sub"))
	repo := mkdir(t, filepath.Join(base, "repo"))
	runGit(t, repo, "init", "-q")
	runGit(t, repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--allow-empty", "-m", "init")
	repoSub := mkdir(t, filepath.Join(repo, "sub"))
	runGit(t, repo, "worktree", "add", "-q", filepath.Join(base, "repo-worktrees", "wt"), "-b", "wt")
	worktreeSub := mkdir(t, filepath.Join(base, "repo-worktrees", "wt", "sub"))
	runGit(t, base, "clone", "-q", "--bare", repo, "bare.git")
	bare := mkdir(t, filepath.Join(base, "bare.git"))
	runGit(t, bare, "-c", "safe.bareRepository=all", "worktree", "add", "-q", "-b", "b", filepath.Join(base, "bare-wt"))
	bareWorktree := mkdir(t, filepath.Join(base, "bare-wt"))

	for _, tc := range []struct{ name, dir, want string }{
		{"outside a repository: the directory itself", plain, plain},
		{"inside the main worktree: its top level", repoSub, repo},
		{"a linked worktree outside the repository: the main worktree", worktreeSub, repo},
		{"a worktree of a bare repository: the repository", bareWorktree, bare},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := claudeProjectRoot(t.Context(), tc.dir)
			if err != nil {
				t.Fatal(err)
			}
			if !pathutil.Equal(got, tc.want) {
				t.Errorf("root = %s, want %s", got, tc.want)
			}
		})
	}
}

// In a worktree beside the repository, the profile's local scope of the main
// worktree wins over the user's server, as on the default profile; a key for
// the worktree's own directory, or a directory above it, is not one Claude
// reads there.
func TestUserMCPServers_LocalScopeOfALinkedWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	f := cliprofiletest.New(t)
	writeDefaultGlobalConfig(t, `{"mcpServers": {"local": {}, "own-dir": {}, "above": {}}}`)
	id, profileDir := f.UseProfile(t, session.AgentTypeClaude)

	base := mkdir(t, t.TempDir())
	repo := mkdir(t, filepath.Join(base, "repo"))
	runGit(t, repo, "init", "-q")
	runGit(t, repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--allow-empty", "-m", "init")
	worktree := filepath.Join(base, "repo-worktrees", "wt")
	runGit(t, repo, "worktree", "add", "-q", worktree, "-b", "wt")
	worktree = mkdir(t, worktree)

	local := func(name string) map[string]any {
		return map[string]any{"mcpServers": map[string]any{name: map[string]any{}}}
	}
	profileConfig, err := json.Marshal(map[string]any{"projects": map[string]any{
		filepath.ToSlash(repo):     local("local"),
		filepath.ToSlash(worktree): local("own-dir"),
		filepath.ToSlash(base):     local("above"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(profileDir, globalConfigFile), string(profileConfig))

	got := slices.Sorted(maps.Keys(serversOf(t, f, id, worktree)))
	if want := []string{"above", "own-dir"}; !slices.Equal(got, want) {
		t.Errorf("servers = %v, want %v", got, want)
	}
}

// Without git the key cannot be known, so every directory from the work
// directory up counts: a main worktree's key is still found from inside it,
// and the session's start does not depend on git.
func TestLocalScopeKeys_WithoutGit(t *testing.T) {
	t.Setenv("PATH", "")
	dir := mkdir(t, filepath.Join(t.TempDir(), "a", "b"))

	keys := localScopeKeys(t.Context(), dir, slog.Default())
	for _, want := range []string{dir, filepath.Dir(dir), filepath.Dir(filepath.Dir(dir))} {
		if !slices.Contains(keys, want) {
			t.Errorf("keys = %v, want %s among them", keys, want)
		}
	}
}

// What Claude reads itself is Claude's to report: a damaged file there costs
// only the check its names, never the user's servers.
func TestUserMCPServers_DamagedShadowingFile(t *testing.T) {
	f := cliprofiletest.New(t)
	writeDefaultGlobalConfig(t, userServersConfig)
	id, profileDir := f.UseProfile(t, session.AgentTypeClaude)
	writeFile(t, filepath.Join(profileDir, globalConfigFile), `{"mcpServers": `)
	workDir := t.TempDir()
	writeFile(t, filepath.Join(workDir, projectMCPFile), `not json`)

	if got := serversOf(t, f, id, workDir); len(got) != 2 {
		t.Errorf("servers = %s, want both of the user's", got)
	}
}

func TestUserMCPServers_MissingOrDamaged(t *testing.T) {
	f := cliprofiletest.New(t)
	id, _ := f.UseProfile(t, session.AgentTypeClaude)
	a := New(f.Store)

	if servers, err := a.userMCPServers(t.Context(), id, t.TempDir(), slog.Default()); err != nil || servers != nil {
		t.Errorf("no file: %v, %v; want none and no error", servers, err)
	}

	path := writeDefaultGlobalConfig(t, `{"mcpServers": `)
	if _, err := a.userMCPServers(t.Context(), id, t.TempDir(), slog.Default()); err == nil {
		t.Errorf("damaged %s read without an error", path)
	}

	writeDefaultGlobalConfig(t, `{"mcpServers": ["not", "an", "object"]}`)
	if _, err := a.userMCPServers(t.Context(), id, t.TempDir(), slog.Default()); err == nil {
		t.Error("mcpServers of the wrong shape read without an error")
	}
}

// Without CLAUDE_CONFIG_DIR the file is ~/.claude.json, beside ~/.claude.
func TestDefaultGlobalConfigPath_Home(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")

	got, err := defaultGlobalConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".claude.json"); got != want {
		t.Errorf("path = %s, want %s", got, want)
	}
}

// The user's servers go in beside Pockode's own, which wins a clash of names;
func TestWriteMCPConfig_UserServers(t *testing.T) {
	userServers := map[string]json.RawMessage{
		"docs":              json.RawMessage(`{"type":"http","url":"https://docs.example.com/mcp"}`),
		agent.MCPServerName: json.RawMessage(`{"command":"impostor"}`),
	}
	path, _, err := writeMCPConfig(agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1"}, userServers, slog.Default())
	if err != nil {
		t.Fatalf("writeMCPConfig: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.MCPServers) != 2 {
		t.Errorf("servers = %v, want docs and %s", config.MCPServers, agent.MCPServerName)
	}
	var docs map[string]string
	if err := json.Unmarshal(config.MCPServers["docs"], &docs); err != nil || docs["url"] != "https://docs.example.com/mcp" {
		t.Errorf("docs = %s, %v; want the user's server", config.MCPServers["docs"], err)
	}
	if args := readMCPArgs(t, path); !hasFlagValue(args, "--session-id", "s1") {
		t.Errorf("%s args = %v; want Pockode's own server", agent.MCPServerName, args)
	}
}

// A session on another profile whose default configuration is damaged still
// starts, and says why its user's servers are missing.
func TestStart_WarnsWhenUserServersUnreadable(t *testing.T) {
	f := cliprofiletest.New(t)
	f.UseProfile(t, session.AgentTypeClaude)
	writeDefaultGlobalConfig(t, `{"mcpServers": `)
	cliprofiletest.FakeOnPath(t, Binary)
	t.Setenv(fakeClaudeRoleEnv, fakeSession)
	t.Setenv(fakeClaudeDirEnv, t.TempDir())

	sess, err := New(f.Store).Start(t.Context(), agent.StartOptions{
		WorkDir: t.TempDir(), DataDir: t.TempDir(), SessionID: "pockode-session",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer sess.Close()
	// The warning is the first thing the session says; the fake says nothing
	// until it is closed.
	select {
	case event := <-sess.Events():
		if w, ok := event.(agent.WarningEvent); !ok || w.Code != "user_mcp_servers_unavailable" {
			t.Errorf("first event = %#v, want the user_mcp_servers_unavailable warning", event)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the session did not warn that the user's MCP servers are missing")
	}
}
