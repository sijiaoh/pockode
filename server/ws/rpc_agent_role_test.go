package ws

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
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
