package ws

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

// roleOverTheWire reads a role back the way a client does, so what is asserted
// is the JSON the UI receives rather than the struct the store holds.
func roleOverTheWire(t *testing.T, env *testEnv, id string) agentrole.AgentRole {
	t.Helper()

	resp := env.call("agent_role.list.subscribe", rpc.SubscribeParams{ID: env.nextSubID()})
	if resp.Error != nil {
		t.Fatalf("agent_role.list.subscribe: %s", resp.Error.Message)
	}
	var result rpc.AgentRoleListSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal role list: %v", err)
	}
	for _, r := range result.Items {
		if r.ID == id {
			return r
		}
	}
	t.Fatalf("role %q missing from the list", id)
	return agentrole.AgentRole{}
}

// TestAgentRoleUpdate_ClearingAgentTypeOverTheWire pins the one field a JSON
// round trip could plausibly lose. `omitempty` is encode-only, so an empty
// agent_type has to survive as a value rather than read as an omission — it is
// what the UI sends to put a role back on the global default, and the store
// only clears the model and effort when the agent actually changes. The store's
// own tests pass Go pointers and so never cross the wire this depends on.
func TestAgentRoleUpdate_ClearingAgentTypeOverTheWire(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	model := session.ModelsForAgent(session.AgentTypeClaude)[0].ID
	effort := session.EffortsForAgent(session.AgentTypeClaude)[0].ID

	resp := env.call("agent_role.update", map[string]any{
		"id":         env.testRoleID,
		"agent_type": string(session.AgentTypeClaude),
		"model":      model,
		"effort":     effort,
	})
	if resp.Error != nil {
		t.Fatalf("setting the engine: %s", resp.Error.Message)
	}

	role := roleOverTheWire(t, env, env.testRoleID)
	if role.AgentType != session.AgentTypeClaude || role.Model != model || role.Effort != effort {
		t.Fatalf("engine = %q/%q/%q, want %q/%q/%q",
			role.AgentType, role.Model, role.Effort, session.AgentTypeClaude, model, effort)
	}

	// One field, as the UI sends it: the reset is the server's to perform.
	resp = env.call("agent_role.update", map[string]any{
		"id":         env.testRoleID,
		"agent_type": "",
	})
	if resp.Error != nil {
		t.Fatalf("clearing the agent type: %s", resp.Error.Message)
	}

	role = roleOverTheWire(t, env, env.testRoleID)
	if role.AgentType != "" {
		t.Errorf("agent type = %q, want it cleared", role.AgentType)
	}
	if role.Model != "" || role.Effort != "" {
		t.Errorf("model/effort = %q/%q, want both dropped with the agent", role.Model, role.Effort)
	}
}

// TestAgentRoleUpdate_RejectionReachesTheClient covers the other half of the
// contract the panel relies on: an impossible combination comes back as
// InvalidParams carrying the store's own message, which the UI shows as-is and
// therefore has to name the offending model and the agent it was judged against.
func TestAgentRoleUpdate_RejectionReachesTheClient(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	codexModel := session.ModelsForAgent(session.AgentTypeCodex)[0].ID
	resp := env.call("agent_role.update", map[string]any{
		"id":         env.testRoleID,
		"agent_type": string(session.AgentTypeClaude),
		"model":      codexModel,
	})

	if resp.Error == nil {
		t.Fatal("expected a model of another agent to be rejected")
	}
	if resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Errorf("code = %d, want InvalidParams (%d)", resp.Error.Code, jsonrpc2.CodeInvalidParams)
	}
	if !strings.Contains(resp.Error.Message, codexModel) ||
		!strings.Contains(resp.Error.Message, string(session.AgentTypeClaude)) {
		t.Errorf("message %q names neither the model nor the agent", resp.Error.Message)
	}
}

// TestAgentRoleWorkTypeOverTheWire covers create, update, clear and rejection of
// work_type through the RPC; clearing is the case a JSON round trip could lose,
// as with agent_type above.
func TestAgentRoleWorkTypeOverTheWire(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("agent_role.create", map[string]any{"name": "Planner", "work_type": "story"})
	if resp.Error != nil {
		t.Fatalf("create: %s", resp.Error.Message)
	}
	var created agentrole.AgentRole
	if err := json.Unmarshal(resp.Result, &created); err != nil {
		t.Fatal(err)
	}
	if role := roleOverTheWire(t, env, created.ID); role.WorkType != work.WorkTypeStory {
		t.Fatalf("work type after create = %q, want story", role.WorkType)
	}

	if resp := env.call("agent_role.update", map[string]any{"id": created.ID, "work_type": ""}); resp.Error != nil {
		t.Fatalf("clear: %s", resp.Error.Message)
	}
	if role := roleOverTheWire(t, env, created.ID); role.WorkType != "" {
		t.Errorf("work type after clear = %q, want empty", role.WorkType)
	}

	for _, method := range []string{"agent_role.create", "agent_role.update"} {
		resp := env.call(method, map[string]any{"id": created.ID, "name": "Bad", "work_type": "epic"})
		if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
			t.Errorf("%s with unknown work type: error = %+v, want InvalidParams", method, resp.Error)
		}
	}
}

// TestAgentRoleDelete_RefusalIsPrintedVerbatim pins the wording of the one
// refusal the client prints without a prefix of its own: the reason is the
// sentence the user reads — `AgentRoleDetailOverlay`'s delete section shows it
// as-is — so both the singular and the plural form are the server's to get
// right.
func TestAgentRoleDelete_RefusalIsPrintedVerbatim(t *testing.T) {
	for _, tc := range []struct {
		name  string
		works int
		want  string
	}{
		{
			name:  "one work item",
			works: 1,
			want:  "Can't delete: 1 work item still uses this role. Change its role, or delete it, first.",
		},
		{
			name:  "several work items",
			works: 3,
			want:  "Can't delete: 3 work items still use this role. Change their role, or delete them, first.",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})

			for i := 0; i < tc.works; i++ {
				if _, err := env.workStore.Create(bgCtx, work.Work{
					Title:       fmt.Sprintf("story %d", i),
					AgentRoleID: env.testRoleID,
				}); err != nil {
					t.Fatalf("create work: %v", err)
				}
			}

			resp := env.call("agent_role.delete", map[string]any{"id": env.testRoleID})
			if resp.Error == nil {
				t.Fatal("expected a role still in use to be undeletable")
			}
			if resp.Error.Code != jsonrpc2.CodeInvalidParams {
				t.Errorf("code = %d, want InvalidParams (%d)", resp.Error.Code, jsonrpc2.CodeInvalidParams)
			}
			if resp.Error.Message != tc.want {
				t.Errorf("message = %q, want %q", resp.Error.Message, tc.want)
			}
		})
	}
}

// The default story role is accepted-and-cleared, never a reason to refuse: a
// role that stops being able to run stories — narrowed to tasks, or deleted —
// takes the default with it, and any other change leaves the default alone.
func TestAgentRole_LosingStoriesClearsTheDefault(t *testing.T) {
	for _, tc := range []struct {
		name      string
		call      func(env *testEnv, id string) rpcResponse
		wantClear bool
	}{
		{
			name: "narrowed to tasks",
			call: func(env *testEnv, id string) rpcResponse {
				return env.call("agent_role.update", map[string]any{"id": id, "work_type": "task"})
			},
			wantClear: true,
		},
		{
			name: "deleted",
			call: func(env *testEnv, id string) rpcResponse {
				return env.call("agent_role.delete", map[string]any{"id": id})
			},
			wantClear: true,
		},
		{
			name: "narrowed to stories",
			call: func(env *testEnv, id string) rpcResponse {
				return env.call("agent_role.update", map[string]any{"id": id, "work_type": "story"})
			},
		},
		{
			name: "renamed",
			call: func(env *testEnv, id string) rpcResponse {
				return env.call("agent_role.update", map[string]any{"id": id, "name": "Lead"})
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})

			id := createRoleOverTheWire(t, env, "PM", "")
			if resp := env.call("settings.update", rpc.SettingsUpdateParams{Settings: settings.Settings{DefaultAgentRoleID: id}}); resp.Error != nil {
				t.Fatalf("settings.update: %s", resp.Error.Message)
			}

			if resp := tc.call(env, id); resp.Error != nil {
				t.Fatalf("role change refused: %s", resp.Error.Message)
			}

			want := id
			if tc.wantClear {
				want = ""
			}
			if got := settingsOverTheWire(t, env).DefaultAgentRoleID; got != want {
				t.Errorf("default = %q, want %q", got, want)
			}
		})
	}
}
