package worktree

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/watch"
	"github.com/pockode/server/work"
)

// idleAgent starts sessions that produce nothing, so the kickoff message has
// somewhere to go without a CLI being installed.
type idleAgent struct{}

func (idleAgent) Start(context.Context, agent.StartOptions) (agent.Session, error) {
	return &idleSession{events: make(chan agent.AgentEvent)}, nil
}

type idleSession struct{ events chan agent.AgentEvent }

func (s *idleSession) Events() <-chan agent.AgentEvent { return s.events }
func (s *idleSession) SendMessage(string) error        { return nil }
func (s *idleSession) SendPermissionResponse(agent.PermissionRequestData, agent.PermissionChoice) error {
	return nil
}
func (s *idleSession) SendQuestionResponse(agent.QuestionRequestData, map[string]string) error {
	return nil
}
func (s *idleSession) SendInterrupt() error { return nil }
func (s *idleSession) Close()               { close(s.events) }

type starterEnv struct {
	starter      *WorkStarter
	roles        agentrole.Store
	sessionStore session.Store
}

// newStarterEnv wires a WorkStarter onto a real session store in the main
// worktree, with the worktree pre-registered so Manager.Get hands it back
// without touching git. Roles in seed are written to disk before the role store
// opens, which is the only way to plant an engine the store's own validation
// would now reject — see TestWorkStarter_RejectsEngineTheAgentCannotRun.
func newStarterEnv(t *testing.T, defaults settings.Settings, seed ...agentrole.AgentRole) starterEnv {
	t.Helper()

	dataDir := t.TempDir()
	sessionStore, err := session.NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("session.NewFileStore: %v", err)
	}

	agents := agent.NewRegistry()
	agents.Register(session.AgentTypeClaude, idleAgent{})
	agents.Register(session.AgentTypeCodex, idleAgent{})
	pm := process.NewManager(agents, t.TempDir(), dataDir, "", sessionStore, time.Minute)
	t.Cleanup(pm.Shutdown)

	wt := &Worktree{
		WorkDir:        t.TempDir(),
		SessionStore:   sessionStore,
		ProcessManager: pm,
		ChatClient:     chat.NewClient(sessionStore, pm),
		subscribers:    make(map[watch.Notifier]struct{}),
	}

	wm := &Manager{
		registry:  NewRegistry(t.TempDir(), dataDir),
		agents:    agents,
		dataDir:   dataDir,
		worktrees: map[string]*Worktree{"": wt},
	}

	roleDir := t.TempDir()
	if len(seed) > 0 {
		writeRoleIndex(t, roleDir, seed)
	}
	roleStore, err := agentrole.NewFileStore(roleDir)
	if err != nil {
		t.Fatalf("agentrole.NewFileStore: %v", err)
	}

	settingsStore, err := settings.NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("settings.NewStore: %v", err)
	}
	if err := settingsStore.Update(defaults); err != nil {
		t.Fatalf("settings Update: %v", err)
	}

	return starterEnv{
		starter:      NewWorkStarter(wm, roleStore, settingsStore),
		roles:        roleStore,
		sessionStore: sessionStore,
	}
}

func writeRoleIndex(t *testing.T, dataDir string, roles []agentrole.AgentRole) {
	t.Helper()
	dir := filepath.Join(dataDir, "agent-roles")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir agent-roles: %v", err)
	}
	data, err := json.Marshal(map[string]any{"roles": roles})
	if err != nil {
		t.Fatalf("marshal roles: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.json"), data, 0644); err != nil {
		t.Fatalf("write role index: %v", err)
	}
}

func newRole(t *testing.T, store agentrole.Store, r agentrole.AgentRole) agentrole.AgentRole {
	t.Helper()
	created, err := store.Create(context.Background(), r)
	if err != nil {
		t.Fatalf("create role: %v", err)
	}
	return created
}

// TestWorkStarter_SessionEngineComesFromRole pins down which of the two sources
// of an engine wins: the role names one, and the global defaults only fill in
// what the role left open.
func TestWorkStarter_SessionEngineComesFromRole(t *testing.T) {
	tests := []struct {
		name     string
		defaults settings.Settings
		role     agentrole.AgentRole
		want     session.SessionMeta
	}{
		{
			name:     "role names the whole engine",
			defaults: settings.Settings{DefaultAgentType: session.AgentTypeClaude, DefaultMode: session.ModeYolo},
			role:     agentrole.AgentRole{Name: "reviewer", AgentType: session.AgentTypeCodex, Model: "gpt-5.6-sol", Effort: "high"},
			want:     session.SessionMeta{AgentType: session.AgentTypeCodex, Mode: session.ModeYolo, Model: "gpt-5.6-sol", Effort: "high"},
		},
		{
			name:     "role leaves the agent open",
			defaults: settings.Settings{DefaultAgentType: session.AgentTypeCodex, DefaultMode: session.ModeDefault},
			role:     agentrole.AgentRole{Name: "engineer"},
			want:     session.SessionMeta{AgentType: session.AgentTypeCodex, Mode: session.ModeDefault},
		},
		{
			name: "role leaving the engine open takes the global model and effort",
			defaults: settings.Settings{
				DefaultAgentType: session.AgentTypeClaude,
				DefaultModel:     "opus",
				DefaultEffort:    "high",
				DefaultMode:      session.ModeDefault,
			},
			role: agentrole.AgentRole{Name: "engineer"},
			want: session.SessionMeta{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault, Model: "opus", Effort: "high"},
		},
		{
			name: "role on the same agent as the global default takes its model",
			defaults: settings.Settings{
				DefaultAgentType: session.AgentTypeClaude,
				DefaultModel:     "opus",
				DefaultMode:      session.ModeDefault,
			},
			role: agentrole.AgentRole{Name: "engineer", AgentType: session.AgentTypeClaude, Effort: "low"},
			want: session.SessionMeta{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault, Model: "opus", Effort: "low"},
		},
		{
			name: "role on another agent is not given the global model",
			defaults: settings.Settings{
				DefaultAgentType: session.AgentTypeClaude,
				DefaultModel:     "opus",
				DefaultEffort:    "high",
				DefaultMode:      session.ModeDefault,
			},
			role: agentrole.AgentRole{Name: "reviewer", AgentType: session.AgentTypeCodex},
			want: session.SessionMeta{AgentType: session.AgentTypeCodex, Mode: session.ModeDefault},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newStarterEnv(t, tt.defaults)
			role := newRole(t, env.roles, tt.role)

			w := work.Work{ID: "w1", Title: "do a thing", SessionID: "sess-1", AgentRoleID: role.ID}
			if err := env.starter.HandleWorkStart(context.Background(), w); err != nil {
				t.Fatalf("HandleWorkStart: %v", err)
			}

			got, found, err := env.sessionStore.Get("sess-1")
			if err != nil || !found {
				t.Fatalf("Get session: found=%v err=%v", found, err)
			}
			if got.AgentType != tt.want.AgentType || got.Mode != tt.want.Mode ||
				got.Model != tt.want.Model || got.Effort != tt.want.Effort {
				t.Errorf("engine = %q/%q/%q/%q, want %q/%q/%q/%q",
					got.AgentType, got.Mode, got.Model, got.Effort,
					tt.want.AgentType, tt.want.Mode, tt.want.Model, tt.want.Effort)
			}
		})
	}
}

// A global default the server no longer offers breaks work start just as a
// stale role does, and the error has to send the user to the settings rather
// than to the role, which holds no model at all.
func TestWorkStarter_RejectsStaleGlobalEngine(t *testing.T) {
	role := agentrole.AgentRole{ID: "role-1", Name: "engineer"}
	defaults := settings.Settings{
		DefaultAgentType: session.AgentTypeClaude,
		DefaultModel:     "retired-model",
		DefaultMode:      session.ModeDefault,
	}
	env := newStarterEnv(t, defaults, role)

	w := work.Work{ID: "w1", Title: "do a thing", SessionID: "sess-1", AgentRoleID: role.ID}
	err := env.starter.HandleWorkStart(context.Background(), w)
	if err == nil {
		t.Fatal("expected an error for a global model the agent cannot run")
	}
	if !strings.Contains(err.Error(), "global defaults") {
		t.Errorf("error %q does not point at the settings the value lives in", err)
	}
	if _, found, _ := env.sessionStore.Get("sess-1"); found {
		t.Error("a session was created despite the invalid engine")
	}
}

// TestWorkStarter_RestartKeepsSessionEngine covers the restart path: the session
// already exists, so it owns its engine, and a role edited in the meantime must
// not be written back over it.
func TestWorkStarter_RestartKeepsSessionEngine(t *testing.T) {
	defaults := settings.Settings{DefaultAgentType: session.AgentTypeClaude, DefaultMode: session.ModeDefault}
	env := newStarterEnv(t, defaults)
	role := newRole(t, env.roles, agentrole.AgentRole{Name: "engineer", AgentType: session.AgentTypeClaude, Model: "opus", Effort: "high"})

	w := work.Work{ID: "w1", Title: "do a thing", SessionID: "sess-1", AgentRoleID: role.ID}
	if err := env.starter.HandleWorkStart(context.Background(), w); err != nil {
		t.Fatalf("first start: %v", err)
	}

	codex := session.AgentTypeCodex
	if err := env.roles.Update(context.Background(), role.ID, agentrole.UpdateFields{AgentType: &codex}); err != nil {
		t.Fatalf("switch role agent: %v", err)
	}

	if err := env.starter.HandleWorkStart(context.Background(), w); err != nil {
		t.Fatalf("restart: %v", err)
	}

	got, _, err := env.sessionStore.Get("sess-1")
	if err != nil {
		t.Fatalf("Get session: %v", err)
	}
	if got.AgentType != session.AgentTypeClaude || got.Model != "opus" || got.Effort != "high" {
		t.Errorf("restart rewrote the engine to %q/%q/%q", got.AgentType, got.Model, got.Effort)
	}
}

// TestWorkStarter_RejectsEngineTheAgentCannotRun covers a role carrying a model
// the server no longer offers — what an upgrade that retires a model leaves
// behind. Starting must fail loudly, naming the role that has to be fixed.
func TestWorkStarter_RejectsEngineTheAgentCannotRun(t *testing.T) {
	stale := agentrole.AgentRole{
		ID:        "role-1",
		Name:      "engineer",
		AgentType: session.AgentTypeClaude,
		Model:     "retired-model",
	}
	defaults := settings.Settings{DefaultAgentType: session.AgentTypeClaude, DefaultMode: session.ModeDefault}
	env := newStarterEnv(t, defaults, stale)

	w := work.Work{ID: "w1", Title: "do a thing", SessionID: "sess-1", AgentRoleID: stale.ID}
	err := env.starter.HandleWorkStart(context.Background(), w)
	if err == nil {
		t.Fatal("expected an error for a model the agent cannot run")
	}
	if !strings.Contains(err.Error(), stale.Name) || !strings.Contains(err.Error(), stale.ID) {
		t.Errorf("error %q does not name the role to fix", err)
	}
	if _, found, _ := env.sessionStore.Get("sess-1"); found {
		t.Error("a session was created despite the invalid engine")
	}
}
