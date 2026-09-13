package ws

import (
	"strings"
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
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
