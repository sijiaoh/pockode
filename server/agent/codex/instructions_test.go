package codex

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/pockode/server/agent"
)

// openWithMCP opens a thread for a session that has the MCP server, against
// canned replies, and returns the session.
func openWithMCP(t *testing.T, opts agent.StartOptions, replies map[string]*rpcResponse) *scriptedSession {
	t.Helper()
	s := newScriptedSession(t, opts, replies)
	s.sess.opts.DisableMCP = false
	if err := s.sess.openThread(context.Background()); err != nil {
		t.Fatalf("openThread error: %v", err)
	}
	return s
}

// startedWith is the developerInstructions the thread/start carried, and
// whether it carried any.
func startedWith(t *testing.T, s *scriptedSession) (string, bool) {
	t.Helper()
	var params map[string]any
	if err := json.Unmarshal(s.writer.waitForRequest(t, "thread/start").Params, &params); err != nil {
		t.Fatal(err)
	}
	di, ok := params["developerInstructions"].(string)
	return di, ok
}

func newThreadOpts(t *testing.T) agent.StartOptions {
	return agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work"}
}

func TestDeveloperInstructions_ANewThreadCarriesTheGuidance(t *testing.T) {
	s := openWithMCP(t, newThreadOpts(t), map[string]*rpcResponse{
		"config/read":  {Result: json.RawMessage(`{"config":{"developer_instructions":null}}`)},
		"thread/start": threadReply("thread-new"),
	})

	if got, _ := startedWith(t, s); got != agent.Guidance {
		t.Errorf("developerInstructions = %q, want agent.Guidance", got)
	}
	// Project config layers are resolved from the directory asked about.
	var params struct {
		Cwd string `json:"cwd"`
	}
	if err := json.Unmarshal(s.writer.waitForRequest(t, "config/read").Params, &params); err != nil || params.Cwd != "/tmp/work" {
		t.Errorf("config/read cwd = %q (%v), want the work dir", params.Cwd, err)
	}
}

// The parameter replaces the user's own developer_instructions, so leaving them
// out would silently drop them from every Pockode session.
func TestDeveloperInstructions_KeepTheUsersOwn(t *testing.T) {
	s := openWithMCP(t, newThreadOpts(t), map[string]*rpcResponse{
		"config/read":  {Result: json.RawMessage(`{"config":{"developer_instructions":"Answer tersely."}}`)},
		"thread/start": threadReply("thread-new"),
	})

	if got, _ := startedWith(t, s); got != "Answer tersely.\n\n"+agent.Guidance {
		t.Errorf("developerInstructions = %q, want the user's followed by the guidance", got)
	}
}

func TestDeveloperInstructions_UnreadableConfigWarnsAndCarriesOn(t *testing.T) {
	s := openWithMCP(t, newThreadOpts(t), map[string]*rpcResponse{
		"config/read":  {Error: &rpcError{Code: -32601, Message: "method not found"}},
		"thread/start": threadReply("thread-new"),
	})

	if got, _ := startedWith(t, s); got != agent.Guidance {
		t.Errorf("developerInstructions = %q, want agent.Guidance", got)
	}
	var warned bool
	for _, ev := range drainEvents(s.sess.events) {
		if w, ok := ev.(agent.WarningEvent); ok && w.Code == "codex_config_unreadable" {
			warned = true
		}
	}
	if !warned {
		t.Error("the user was not told their developer_instructions may be missing")
	}
}

// The guidance would point at a question_post that is not there.
func TestDeveloperInstructions_NoneWithoutTheMCPServer(t *testing.T) {
	s := newScriptedSession(t, newThreadOpts(t), map[string]*rpcResponse{
		"thread/start": threadReply("thread-new"),
	})
	if err := s.sess.openThread(context.Background()); err != nil {
		t.Fatalf("openThread error: %v", err)
	}

	if _, ok := startedWith(t, s); ok {
		t.Error("developerInstructions sent to a session without the MCP server")
	}
	if slices.Contains(s.methodsSent(), "config/read") {
		t.Error("config/read sent for instructions that are not going to be sent")
	}
}

// A reopened thread keeps the developer instructions it started with, whatever
// the reopening call says, so reading the user's config for it is a round trip
// spent for nothing.
func TestDeveloperInstructions_OnlyANewThreadReadsTheConfig(t *testing.T) {
	opts := newThreadOpts(t)
	newResumeStateStore(opts, testLogger()).record("thread-old")

	s := openWithMCP(t, opts, map[string]*rpcResponse{
		// Answered, so that a resume which does read fails here rather than
		// hanging on a reply that never comes.
		"config/read":   {Result: json.RawMessage(`{"config":{}}`)},
		"thread/resume": threadReply("thread-old"),
	})

	if slices.Contains(s.methodsSent(), "config/read") {
		t.Errorf("methods sent = %v, want no config/read for a resume", s.methodsSent())
	}
}
