package ws

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

// The global model and effort are only meaningful next to the global agent
// type, so a pair left over from the agent the user just switched away from has
// to be refused rather than stored and silently ignored later.
func TestHandler_SettingsUpdate_RejectsEngineTheAgentCannotRun(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("settings.update", rpc.SettingsUpdateParams{Settings: settings.Settings{
		DefaultAgentType: session.AgentTypeClaude,
		DefaultModel:     "gpt-5.6-sol",
	}})

	if resp.Error == nil {
		t.Fatal("expected a codex model under the claude agent to be refused")
	}
	if !strings.Contains(resp.Error.Message, "gpt-5.6-sol") {
		t.Errorf("expected the message to name the model, got %q", resp.Error.Message)
	}
}

// A session created by hand carries no role, so the global defaults are the
// whole engine it is born with.
func TestHandler_SessionCreate_UsesGlobalEngine(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("settings.update", rpc.SettingsUpdateParams{Settings: settings.Settings{
		DefaultAgentType: session.AgentTypeClaude,
		DefaultModel:     "opus",
		DefaultEffort:    "high",
	}})
	if resp.Error != nil {
		t.Fatalf("settings.update: %s", resp.Error.Message)
	}

	_, created := env.createSession()

	if created.Model != "opus" || created.Effort != "high" {
		t.Errorf("session engine = %q/%q, want opus/high", created.Model, created.Effort)
	}
}

// The agent setting is one a user may never have touched, while their sessions
// have been running on the built-in default all along. So a model picked for
// that default has to be accepted without first making them state the agent —
// the client does not send one — and it has to reach the session, which is the
// only proof the value was stored against the agent it will really run under.
func TestHandler_SettingsUpdate_AcceptsAModelWithNoAgentSet(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("settings.update", rpc.SettingsUpdateParams{Settings: settings.Settings{
		DefaultModel: "opus",
	}})
	if resp.Error != nil {
		t.Fatalf("a model for the built-in default agent was refused: %s", resp.Error.Message)
	}

	_, created := env.createSession()

	if created.AgentType != session.DefaultAgentType || created.Model != "opus" {
		t.Errorf("session engine = %q/%q, want %q/opus", created.AgentType, created.Model, session.DefaultAgentType)
	}
}

func settingsOverTheWire(t *testing.T, env *testEnv) settings.Settings {
	t.Helper()

	resp := env.call("settings.subscribe", rpc.SubscribeParams{ID: env.nextSubID()})
	if resp.Error != nil {
		t.Fatalf("settings.subscribe: %s", resp.Error.Message)
	}
	var result rpc.SettingsSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal settings: %v", err)
	}
	return result.Settings
}

// createRoleOverTheWire creates a role with the given work type ("" for both)
// and returns its id.
func createRoleOverTheWire(t *testing.T, env *testEnv, name string, workType work.WorkType) string {
	t.Helper()

	resp := env.call("agent_role.create", map[string]any{"name": name, "work_type": string(workType)})
	if resp.Error != nil {
		t.Fatalf("agent_role.create: %s", resp.Error.Message)
	}
	var role agentrole.AgentRole
	if err := json.Unmarshal(resp.Result, &role); err != nil {
		t.Fatal(err)
	}
	return role.ID
}

// The default agent role is the one a new story starts on, so a role that
// cannot run stories is refused as the default — by name, since the client
// prints the message.
func TestHandler_SettingsUpdate_DefaultRoleMustRunStories(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	taskRole := createRoleOverTheWire(t, env, "Engineer", work.WorkTypeTask)
	resp := env.call("settings.update", rpc.SettingsUpdateParams{Settings: settings.Settings{DefaultAgentRoleID: taskRole}})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("task-only default: error = %+v, want InvalidParams", resp.Error)
	}
	if !strings.Contains(resp.Error.Message, "Engineer") {
		t.Errorf("message %q does not name the role", resp.Error.Message)
	}
	if got := settingsOverTheWire(t, env).DefaultAgentRoleID; got != "" {
		t.Errorf("default = %q, want it left unset", got)
	}

	for _, workType := range []work.WorkType{work.WorkTypeStory, ""} {
		id := createRoleOverTheWire(t, env, "Runs "+string(workType), workType)
		resp := env.call("settings.update", rpc.SettingsUpdateParams{Settings: settings.Settings{DefaultAgentRoleID: id}})
		if resp.Error != nil {
			t.Errorf("work type %q refused as the default: %s", workType, resp.Error.Message)
		}
	}
}

// A stored default only gets judged when it changes: settings.update replaces
// the whole object, so a value gone stale outside the server (an edit to
// settings.json) must not block saving an unrelated setting.
func TestHandler_SettingsUpdate_StaleDefaultRoleDoesNotBlockOtherSettings(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	taskRole := createRoleOverTheWire(t, env, "Engineer", work.WorkTypeTask)
	if err := env.handler.settingsStore.Update(settings.Settings{DefaultAgentRoleID: taskRole}); err != nil {
		t.Fatal(err)
	}

	resp := env.call("settings.update", rpc.SettingsUpdateParams{Settings: settings.Settings{
		DefaultAgentRoleID: taskRole,
		DefaultMode:        session.ModeYolo,
	}})
	if resp.Error != nil {
		t.Fatalf("an unrelated change was refused over the stored default: %s", resp.Error.Message)
	}
}
