//go:build integration

package permreview_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/cliprofile/cliprofiletest"
	"github.com/pockode/server/mcp"
	"github.com/pockode/server/permreview"
	"github.com/pockode/server/serverinfo"
	"github.com/pockode/server/session"
	"github.com/pockode/server/worktree"
)

// unattendedTimeout is a ceiling on the whole scenario, not a wait: one turn of
// the main session's, held for the reviewer's cold start and one review. It
// sits above permreview.DefaultTimeout so that a reviewer that never answers is
// reported as Pockode's timeout deny, which says what went wrong, rather than
// as this test giving up first.
const unattendedTimeout = permreview.DefaultTimeout + 3*time.Minute

// checkCommand is the call the main agent is made to run, and askRule the
// project permission rule that makes Claude Code ask about it even under
// bypassPermissions: explicit ask rules are honoured in that mode.
//
// An ask rule rather than one of Claude Code's own safety checks, because none
// of the harmless forms of those raised a request on the CLI version this was
// written against (2.1.325): an rm whose target is a command substitution or a
// variable, and writes into .claude/ or .git/, all ran without asking. What is
// under test is the flow after the request, not which check raises it, and an
// echo is harmless whatever the reviewer decides. The rule lives only in the
// test's own temporary project.
const (
	checkCommand = "echo pockode-unattended-check"
	askRule      = "Bash(" + checkCommand + ")"
)

// doneMarker is what the main agent says once the call has been answered,
// either way: seeing it after the verdict is how the test knows the turn went
// on rather than ending with the request.
const doneMarker = "UNATTENDED-FINISHED"

// TestMain lets this test binary be the MCP proxy. Claude spawns the proxy as
// `<os.Executable()> mcp ...`, which in a test is this binary rather than the
// server's, and the reviewer's permission_verdict is reached through it.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		if err := mcp.RunProxy(os.Args[2:], "unattended-integration"); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// TestIntegration_UnattendedClaude runs the whole Unattended path against the
// real Claude CLI and model: a main session in unattended raises a permission
// request that bypassPermissions does not skip, its reviewer session is
// created and sent the request, the reviewer answers through
// permission_verdict, and the main session gets the answer and carries on.
//
// Either verdict passes. What is under test is that a real reviewer gives one
// through the tool and that it reaches the main session — not what it decides,
// which is the model's. Pockode's own deny (timeout, no verdict, a failed
// reviewer) fails the test, because it means the reviewer never answered.
func TestIntegration_UnattendedClaude(t *testing.T) {
	if _, err := exec.LookPath(claude.Binary); err != nil {
		t.Fatalf("claude CLI not found in PATH: %v", err)
	}

	workDir := t.TempDir()
	settings, err := json.Marshal(map[string]any{"permissions": map[string]any{"ask": []string{askRule}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(workDir, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workDir, ".claude", "settings.json"), settings, 0o644); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()

	agents := agent.NewRegistry()
	agents.Register(session.AgentTypeClaude, claude.New(cliprofiletest.UserStore()))
	registry := worktree.NewRegistry(workDir, dataDir)
	manager := worktree.NewManager(registry, agents, dataDir, session.LeaseBudgets{})
	// The cheapest engine Claude has: a verdict on one call is a short
	// judgement, and every review is paid for.
	manager.SetPermissionReviewerEngine(func(session.AgentType) session.Engine {
		return session.Engine{AgentType: session.AgentTypeClaude, Model: "haiku", Effort: "low"}
	})
	startLocalAPI(t, dataDir, registry, manager)
	// Registered after the local API, so it runs first: the CLIs stop while
	// their MCP proxies still have a server to talk to.
	t.Cleanup(manager.Shutdown)

	wt, err := manager.Get("")
	if err != nil {
		t.Fatalf("get main worktree: %v", err)
	}
	t.Cleanup(func() { manager.Release(wt) })

	ctx, cancel := context.WithTimeout(context.Background(), unattendedTimeout)
	defer cancel()

	mainID := uuid.NewString()
	if _, err := wt.SessionStore.Create(ctx, mainID, session.CreateSpec{
		AgentType: session.AgentTypeClaude,
		Mode:      session.ModeUnattended,
		Model:     "haiku",
	}); err != nil {
		t.Fatalf("create main session: %v", err)
	}

	prompt := fmt.Sprintf("Run this exact shell command once with the Bash tool, unchanged:\n\n%s\n\n"+
		"Whether it is allowed or denied, do not retry it or run anything else. "+
		"Afterwards reply with the single word %s and nothing else.", checkCommand, doneMarker)
	started := time.Now()
	if _, err := wt.ChatClient.SendMessageExcluding(ctx, mainID, prompt, nil, nil); err != nil {
		t.Fatalf("send to main session: %v", err)
	}

	mainRecords := waitForTurnEnd(t, ctx, wt.SessionStore, mainID)
	elapsed := time.Since(started).Round(time.Second)

	reviewer, found, err := session.FindPermissionReviewer(wt.SessionStore, mainID)
	if err != nil {
		t.Fatalf("find reviewer: %v", err)
	}
	var reviewerRecords []agent.EventRecord
	if found {
		reviewerRecords = readHistory(t, ctx, wt.SessionStore, reviewer.ID)
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("main session history:\n%s", describe(mainRecords))
			t.Logf("reviewer session history:\n%s", describe(reviewerRecords))
		}
	})

	requests := ofType(mainRecords, agent.EventTypePermissionRequest)
	if len(requests) == 0 {
		t.Fatalf("the main session raised no permission request; Claude Code may no longer honour the project ask rule %q under bypassPermissions", askRule)
	}
	if !found {
		t.Fatal("a permission request was raised but no reviewer session was created")
	}
	if reviewer.PermissionReviewerOf != mainID {
		t.Errorf("reviewer's permission_reviewer_of = %q, want %q", reviewer.PermissionReviewerOf, mainID)
	}
	if len(withSubtype(reviewerRecords, permreview.MessageSubtype)) == 0 {
		t.Error("the reviewer session was never sent a review message")
	}

	verdictCalls := 0
	for _, r := range ofType(reviewerRecords, agent.EventTypeToolCall) {
		if strings.HasSuffix(r.ToolName, agent.PermissionVerdictTool) {
			verdictCalls++
		}
	}

	responses := ofType(mainRecords, agent.EventTypePermissionResponse)
	firstVerdict := -1
	for i, r := range mainRecords {
		if r.Type != agent.EventTypePermissionResponse {
			continue
		}
		switch r.By {
		case agent.RespondedByPermissionReviewer:
			if firstVerdict < 0 {
				firstVerdict = i
			}
		case agent.RespondedByPockode:
			reason := ""
			if r.Review != nil {
				reason = fmt.Sprintf("%s: %s", r.Review.Automatic, r.Review.Reason)
			}
			t.Errorf("request %s was denied by Pockode, not by the reviewer (%s)", r.RequestID, reason)
		default:
			t.Errorf("request %s was answered by %q, want the permission reviewer", r.RequestID, r.By)
		}
	}
	if firstVerdict < 0 {
		t.Fatalf("no request was answered by the reviewer (%d responses, %d permission_verdict calls)", len(responses), verdictCalls)
	}
	if verdictCalls == 0 {
		t.Error("the main session got a reviewer's verdict but the reviewer's history shows no permission_verdict call")
	}

	end := mainRecords[len(mainRecords)-1]
	if end.Type != agent.EventTypeDone {
		t.Errorf("the main turn ended with %q, want done: a verdict must not end the turn", end.Type)
	}
	saidAfter := false
	for _, r := range mainRecords[firstVerdict+1:] {
		if r.Type == agent.EventTypeText && strings.Contains(r.Content, doneMarker) {
			saidAfter = true
		}
	}
	if !saidAfter {
		t.Errorf("the main agent never said %s after the verdict, so the turn did not visibly carry on", doneMarker)
	}

	verdict := mainRecords[firstVerdict]
	category, reason := "", ""
	if verdict.Review != nil {
		category, reason = string(verdict.Review.Category), verdict.Review.Reason
	}
	// The reviewer's cost is what it has reported so far: its turn may still be
	// ending when the main one has.
	t.Logf("main turn ended in %s: %d request(s), %d permission_verdict call(s); first verdict %s %s %q; cost: main %s, reviewer %s",
		elapsed, len(requests), verdictCalls, verdict.Choice, category, reason,
		costOf(wt.SessionStore, mainID), costOf(wt.SessionStore, reviewer.ID))
}

// startLocalAPI serves the MCP local API the way the server does, with only
// what this scenario reaches wired: permission_verdict, answered through each
// worktree's permission reviews. server.json goes in dataDir, the directory
// every session's MCP proxy is pointed at.
func startLocalAPI(t *testing.T, dataDir string, registry *worktree.Registry, manager *worktree.Manager) {
	t.Helper()
	executor := mcp.NewExecutor(nil, nil, nil, nil, registry, manager)
	executor.SetPermissionReviews(func(name string) (mcp.PermissionReviewService, func(), error) {
		return manager.ResolvePermissionReviews(name)
	})
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	token := hex.EncodeToString(b)
	mux := http.NewServeMux()
	mux.Handle(mcp.APIPath, mcp.NewAPIHandler(executor, token))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	if err := serverinfo.Write(dataDir, "dev", 0, srv.URL, "", token); err != nil {
		t.Fatalf("write server.json: %v", err)
	}
}

// waitForTurnEnd reads the session's history until the turn the test started
// has ended, and returns it. A permission request does not end a turn; only
// what the CLI reports as the end of one, or the process going, does.
func waitForTurnEnd(t *testing.T, ctx context.Context, store session.Store, sessionID string) []agent.EventRecord {
	t.Helper()
	for {
		records := readHistory(t, ctx, store, sessionID)
		if n := len(records); n > 0 {
			switch records[n-1].Type {
			case agent.EventTypeDone, agent.EventTypeInterrupted, agent.EventTypeError, agent.EventTypeProcessEnded:
				return records
			}
		}
		select {
		case <-ctx.Done():
			t.Fatalf("the main turn did not end within %s; history so far:\n%s", unattendedTimeout, describe(records))
		case <-time.After(time.Second):
		}
	}
}

func readHistory(t *testing.T, ctx context.Context, store session.Store, sessionID string) []agent.EventRecord {
	t.Helper()
	raw, err := store.GetHistory(ctx, sessionID)
	if err != nil {
		t.Fatalf("read history of %s: %v", sessionID, err)
	}
	records := make([]agent.EventRecord, 0, len(raw))
	for _, r := range raw {
		var rec agent.EventRecord
		if err := json.Unmarshal(r, &rec); err != nil {
			t.Fatalf("decode a history record of %s: %v\n%s", sessionID, err, r)
		}
		records = append(records, rec)
	}
	return records
}

func ofType(records []agent.EventRecord, typ agent.EventType) []agent.EventRecord {
	var out []agent.EventRecord
	for _, r := range records {
		if r.Type == typ {
			out = append(out, r)
		}
	}
	return out
}

func withSubtype(records []agent.EventRecord, subtype string) []agent.EventRecord {
	var out []agent.EventRecord
	for _, r := range records {
		if r.Subtype == subtype {
			out = append(out, r)
		}
	}
	return out
}

// describe is one line per record, enough to read a failed run by.
func describe(records []agent.EventRecord) string {
	var b strings.Builder
	for _, r := range records {
		fmt.Fprintf(&b, "  %s", r.Type)
		for _, part := range []string{r.Subtype, r.ToolName, string(r.ToolInput), r.Choice, string(r.By), r.Content, r.Message, r.Error} {
			if part != "" {
				fmt.Fprintf(&b, " | %.300s", part)
			}
		}
		if r.Review != nil {
			fmt.Fprintf(&b, " | review %+v", *r.Review)
		}
		b.WriteByte('\n')
	}
	return b.String()
}

func costOf(store session.Store, sessionID string) string {
	meta, found, err := store.Get(sessionID)
	if err != nil || !found || meta.Usage.CostUSD == nil {
		return "unknown"
	}
	return fmt.Sprintf("$%.4f", *meta.Usage.CostUSD)
}
