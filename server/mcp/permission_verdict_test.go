package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/permreview"
)

// stubReviews is a permission review service that records the verdict it was
// handed and answers as told.
type stubReviews struct {
	reviewer string
	verdict  permreview.Verdict
	outcome  permreview.Outcome
	err      error
	pending  string
}

func (s *stubReviews) Verdict(_ context.Context, reviewerID string, v permreview.Verdict) (permreview.Outcome, error) {
	s.reviewer, s.verdict = reviewerID, v
	return s.outcome, s.err
}

func (s *stubReviews) PendingSummary(string) string { return s.pending }

func execWithReviews(stub *stubReviews) *Executor {
	e := NewExecutor(nil, nil, nil, nil, nil, nil)
	e.SetPermissionReviews(func(string) (PermissionReviewService, func(), error) {
		return stub, func() {}, nil
	})
	return e
}

func callVerdict(t *testing.T, e *Executor, caller Caller, args map[string]string) (string, error) {
	t.Helper()
	raw, _ := json.Marshal(args)
	return e.Execute(context.Background(), caller, agent.PermissionVerdictTool, raw)
}

var reviewerCaller = Caller{SessionID: "reviewer-1", Worktree: "feature-x"}

func TestPermissionVerdict_PassesTheVerdictOn(t *testing.T) {
	stub := &stubReviews{pending: "Still waiting for your verdict: req-2 (Bash)."}
	text, err := callVerdict(t, execWithReviews(stub), reviewerCaller, map[string]string{
		"request_id": "req-1", "verdict": "deny", "category": "system_damage", "reason": "deletes /usr",
	})
	if err != nil {
		t.Fatalf("permission_verdict: %v", err)
	}
	want := permreview.Verdict{RequestID: "req-1", Category: agent.DenySystemDamage, Reason: "deletes /usr"}
	if stub.reviewer != "reviewer-1" || stub.verdict != want {
		t.Errorf("service got %q %+v, want reviewer-1 %+v", stub.reviewer, stub.verdict, want)
	}
	// The reviewer learns what is still waiting, so one answer is not taken
	// for the last.
	if !strings.Contains(text, "Denied request req-1") || !strings.Contains(text, "req-2 (Bash)") {
		t.Errorf("result = %q", text)
	}
}

// A request someone else answered is not the reviewer's mistake: the tool
// says so and succeeds.
func TestPermissionVerdict_NoLongerPending(t *testing.T) {
	stub := &stubReviews{outcome: permreview.NoLongerPending}
	text, err := callVerdict(t, execWithReviews(stub), reviewerCaller, map[string]string{"request_id": "req-1", "verdict": "allow"})
	if err != nil || !strings.Contains(text, "no longer pending") {
		t.Errorf("result = %q, %v; want a success saying the request is no longer pending", text, err)
	}
}

// Refusals reach the reviewer as errors it can act on, and the ones caused by
// what it sent are marked as such rather than logged as server faults.
func TestPermissionVerdict_Refusals(t *testing.T) {
	tests := []struct {
		name    string
		caller  Caller
		args    map[string]string
		stubErr error
		want    string
	}{
		{"no caller", Caller{}, map[string]string{"request_id": "req-1", "verdict": "allow"}, nil, "only for a permission reviewer"},
		{"no request id", reviewerCaller, map[string]string{"verdict": "allow"}, nil, "request_id is required"},
		{"unknown verdict", reviewerCaller, map[string]string{"request_id": "req-1", "verdict": "always_allow"}, nil, "verdict must be"},
		{"deny without category", reviewerCaller, map[string]string{"request_id": "req-1", "verdict": "deny"}, permreview.ErrDenyNeedsCategory, "call permission_verdict again with a category"},
		{"not routed", reviewerCaller, map[string]string{"request_id": "req-1", "verdict": "allow"}, permreview.ErrNotRouted, "no permission request with this id"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := callVerdict(t, execWithReviews(&stubReviews{err: tt.stubErr}), tt.caller, tt.args)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want one containing %q", err, tt.want)
			}
			if !isUserError(err) {
				t.Errorf("%v is not marked as the caller's error", err)
			}
		})
	}
}

// A fault applying the verdict is the server's, and is reported as one.
func TestPermissionVerdict_ServiceFault(t *testing.T) {
	_, err := callVerdict(t, execWithReviews(&stubReviews{err: errors.New("disk on fire")}), reviewerCaller, map[string]string{"request_id": "req-1", "verdict": "allow"})
	if err == nil || isUserError(err) {
		t.Errorf("err = %v, want a server fault", err)
	}
}

func TestParseProxyArgs_PermissionReviewer(t *testing.T) {
	got, err := parseProxyArgs([]string{"--data-dir", "/d", "--session-id", "r1", "--permission-reviewer"}, flag.ContinueOnError)
	if err != nil {
		t.Fatalf("parseProxyArgs: %v", err)
	}
	if !got.permissionReviewer {
		t.Error("--permission-reviewer was not read")
	}
}

func toolNames(t *testing.T, s *Server) []string {
	t.Helper()
	b, _ := json.Marshal(callMethod(t, s, "tools/list", nil).Result)
	var result toolsListResult
	if err := json.Unmarshal(b, &result); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, def := range result.Tools {
		names = append(names, def.Name)
	}
	return names
}

// A reviewer sees the verdict tool and nothing else, and no instructions about
// tools it lacks; every other session sees everything but the verdict tool.
func TestServer_ToolSets(t *testing.T) {
	if got := toolNames(t, NewPermissionReviewerServer(nil, "test")); len(got) != 1 || got[0] != agent.PermissionVerdictTool {
		t.Errorf("reviewer tools = %v, want permission_verdict alone", got)
	}
	b, _ := json.Marshal(callMethod(t, NewPermissionReviewerServer(nil, "test"), "initialize", nil).Result)
	var init initializeResult
	_ = json.Unmarshal(b, &init)
	if init.Instructions != "" {
		t.Errorf("reviewer instructions = %q, want none", init.Instructions)
	}

	for _, name := range toolNames(t, NewServer(nil, "test")) {
		if name == agent.PermissionVerdictTool {
			t.Error("an ordinary session is offered permission_verdict")
		}
	}
}

// What a proxy does not offer it does not forward: a reviewer cannot reach
// the work tools, nor another session the verdict tool, by naming them.
func TestServer_RefusesToolsItDoesNotOffer(t *testing.T) {
	tests := []struct {
		name   string
		server func(*Client) *Server
		tool   string
	}{
		{"reviewer calling a work tool", func(c *Client) *Server { return NewPermissionReviewerServer(c, "test") }, "story_list"},
		{"ordinary session calling the verdict tool", func(c *Client) *Server { return NewServer(c, "test") }, agent.PermissionVerdictTool},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			proxy, rec := newProxyToRecorder(t, reviewerCaller)
			s := tt.server(proxy.client)
			resp := callToolViaProxy(t, s, tt.tool, map[string]string{})
			if resp.Error == nil || resp.Error.Code != -32602 {
				t.Errorf("response = %+v, want an unknown-tool error", resp)
			}
			if rec.caller != (Caller{}) {
				t.Error("the call reached the server")
			}
		})
	}
}

// The definition the reviewer reads offers exactly the categories a deny is
// accepted with, so a schema-following reviewer cannot be refused for its
// category.
func TestPermissionVerdictTool_CategoriesAreTheValidOnes(t *testing.T) {
	for _, category := range reviewerToolDefinitions[0].InputSchema.Properties["category"].Enum {
		if !agent.PermissionDenyCategory(category).Valid() {
			t.Errorf("schema offers %q, which a deny is refused with", category)
		}
	}
	if got := len(reviewerToolDefinitions[0].InputSchema.Properties["category"].Enum); got != 3 {
		t.Errorf("schema offers %d categories, want 3", got)
	}
}
