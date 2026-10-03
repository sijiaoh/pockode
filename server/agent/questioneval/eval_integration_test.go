//go:build integration

package questioneval

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/agent/codex"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/mcp"
	"github.com/pockode/server/serverinfo"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
)

// The two knobs. Both are environment variables rather than test flags so that
// a pattern like ./... does not refuse every other package for not knowing
// them; which CLI and which scenario run is -run's to choose.
const (
	// runsEnv is how many times each selected scenario runs on each selected
	// CLI. Unset, the whole eval skips: this is the one suite in the repository
	// where an accidental `-tags=integration ./...` would bill for dozens of
	// long turns, so running it at all takes saying how many.
	runsEnv = "QUESTION_EVAL_RUNS"
	// outEnv is where the evidence goes. Unset, a fresh directory under the
	// system temp dir, named in the log. Runs write fixed names into it, so two
	// invocations running at once — one per CLI, say — each need their own.
	outEnv = "QUESTION_EVAL_OUT"
)

// turnTimeout is a ceiling on one scenario's turn, not a wait. Several of these
// turns write code and run it, which takes minutes rather than the seconds the
// shared suite's turns do.
const turnTimeout = 15 * time.Minute

var clis = []struct {
	name string
	new  func() agent.Agent
}{
	{"claude", func() agent.Agent { return claude.New() }},
	{"codex", func() agent.Agent { return codex.New() }},
}

// TestMain lets this test binary be the MCP proxy. Both CLIs spawn the proxy as
// `<os.Executable()> mcp ...`, which in a test is this binary rather than the
// server's — so it has to answer to that subcommand the way the server does.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		if err := runProxy(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// toolsListedMarker is the file the proxy leaves in its data dir once the CLI
// has asked it for its tools.
//
// It is what tells "the agent chose not to call question_post" apart from "the
// agent never had question_post": a CLI that fails to start an MCP server says
// so nowhere Pockode reads, and goes on to answer the scenario without it — a
// run that would be judged like any other and mean nothing.
const toolsListedMarker = "tools-listed"

// runProxy is mcp.RunProxy with its input watched for the tools/list request,
// which it marks by writing toolsListedMarker.
func runProxy(args []string) error {
	dataDir := ""
	for i, a := range args {
		if a == "--data-dir" && i+1 < len(args) {
			dataDir = args[i+1]
		}
	}

	r, w, err := os.Pipe()
	if err != nil {
		return err
	}
	in := bufio.NewReader(os.Stdin)
	os.Stdin = r
	go func() {
		defer w.Close()
		marked := false
		for {
			line, err := in.ReadBytes('\n')
			if !marked && bytes.Contains(line, []byte(`"tools/list"`)) {
				marked = true
				if werr := os.WriteFile(filepath.Join(dataDir, toolsListedMarker), nil, 0o644); werr != nil {
					fmt.Fprintf(os.Stderr, "Error: mark tools listed: %v\n", werr)
				}
			}
			if _, werr := w.Write(line); werr != nil || err != nil {
				return
			}
		}
	}()
	return mcp.RunProxy(args, "question-eval")
}

// TestQuestionEval runs every scenario on every CLI, QUESTION_EVAL_RUNS times
// each. Subtests are <cli>/<scenario>/run-<n>; select with an anchored -run.
//
// A bad verdict does not fail the test — the eval measures, and what it
// measures is in summary.md. The test fails only when a run could not be
// carried out at all.
func TestQuestionEval(t *testing.T) {
	if os.Getenv(runsEnv) == "" {
		t.Skipf("set %s to the number of runs per scenario and CLI; every run is a real, paid turn (see docs/testing.md)", runsEnv)
	}
	runs, err := strconv.Atoi(os.Getenv(runsEnv))
	if err != nil || runs < 1 {
		t.Fatalf("%s=%q: want a positive integer", runsEnv, os.Getenv(runsEnv))
	}

	out := os.Getenv(outEnv)
	if out == "" {
		out, err = os.MkdirTemp("", "question-eval-"+time.Now().Format("20060102-150405")+"-")
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("evidence: %s", out)

	// The api-key scenario is about a key the user has not set. One set in the
	// environment the CLIs inherit would let the script simply work.
	t.Setenv(WeatherKeyEnv, "")

	var results []RunResult
	t.Cleanup(func() {
		if len(results) == 0 {
			return
		}
		path := filepath.Join(out, "summary.md")
		if err := os.WriteFile(path, []byte(Summary(results)), 0o644); err != nil {
			t.Errorf("write summary: %v", err)
			return
		}
		t.Logf("summary: %s\n%s", path, Summary(results))
	})

	for _, cli := range clis {
		t.Run(cli.name, func(t *testing.T) {
			if _, err := exec.LookPath(cliBinary(cli.name)); err != nil {
				t.Fatalf("%s CLI not found in PATH: %v", cli.name, err)
			}
			for _, sc := range Scenarios {
				t.Run(sc.Name, func(t *testing.T) {
					for n := 1; n <= runs; n++ {
						t.Run(fmt.Sprintf("run-%d", n), func(t *testing.T) {
							r := runScenario(t, cli.new(), sc)
							r.CLI, r.Run = cli.name, n
							dir := filepath.Join(out, cli.name, sc.Name)
							if err := writeResult(dir, n, r); err != nil {
								t.Fatalf("write evidence: %v", err)
							}
							t.Logf("%s (scenario %s, choices %s, %s, $%.4f)\n  %s",
								r.Verdict, r.Scenario.Verdict, r.Choices.Verdict, r.Duration, r.CostUSD,
								strings.Join(r.Reasons(), "\n  "))
							results = append(results, r)
						})
					}
				})
			}
		})
	}
}

func cliBinary(name string) string {
	if name == "claude" {
		return claude.Binary
	}
	return codex.Binary
}

// runScenario puts one scenario to one fresh session and judges what came of it.
func runScenario(t *testing.T, a agent.Agent, sc Scenario) RunResult {
	workDir := fixtureRepo(t, sc.Name)
	sessionID := uuid.NewString()
	recorder := startToolServer(t, sessionID)

	var usageMu sync.Mutex
	var usage session.TokenUsage
	var cost float64

	ctx, cancel := context.WithTimeout(context.Background(), turnTimeout)
	defer cancel()
	sess, err := a.Start(ctx, agent.StartOptions{
		WorkDir:      workDir,
		DataDir:      t.TempDir(),
		MCPServerDir: recorder.dir,
		SessionID:    sessionID,
		// Yolo, as the shared suite does: nobody is there to answer a
		// permission prompt, and the scenarios are about questions, not those.
		Mode: session.ModeYolo,
		OnUsage: func(r session.UsageReport) {
			usageMu.Lock()
			defer usageMu.Unlock()
			usage = usage.Add(r.Added)
			if r.AddedCostUSD != nil {
				cost += *r.AddedCostUSD
			}
		},
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	started := time.Now()
	turn := agent.TurnOn(t, ctx, sess, sc.Prompt)
	elapsed := time.Since(started)

	if _, err := os.Stat(filepath.Join(recorder.dir, toolsListedMarker)); err != nil {
		t.Fatalf("the CLI never listed Pockode's MCP tools, so this run had no question_post to call: %v", err)
	}

	calls := recorder.calls()
	e := NewEvidence(calls, turn.Said, remainingFiles(t, workDir))
	r := RunResult{
		ScenarioName:  sc.Name,
		Prompt:        sc.Prompt,
		Duration:      elapsed.Round(time.Second).String(),
		ToolCalls:     calls,
		Posts:         e.Posts,
		Said:          turn.Said,
		TextQuestions: e.TextQuestions(),
		Scenario:      sc.Judge(e),
		Choices:       JudgeChoices(e),
		Records:       turn.Records,
	}
	r.Verdict = Combine(r.Scenario, r.Choices)
	usageMu.Lock()
	r.Usage, r.CostUSD = usage, cost
	usageMu.Unlock()
	return r
}

// writeResult writes run-<n>.json and run-<n>.events.jsonl into dir.
func writeResult(dir string, n int, r RunResult) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("run-%d.json", n)), data, 0o644); err != nil {
		return err
	}
	var events bytes.Buffer
	for _, rec := range r.Records {
		events.Write(rec)
		events.WriteByte('\n')
	}
	return os.WriteFile(filepath.Join(dir, fmt.Sprintf("run-%d.events.jsonl", n)), events.Bytes(), 0o644)
}

// fixtureRepo copies a scenario's fixture (testdata/<scenario>) into a fresh
// git repository, so the agent finds what a user's checkout would look like:
// files and a history.
func fixtureRepo(t *testing.T, scenario string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "repo")
	if err := os.CopyFS(dir, os.DirFS(filepath.Join("testdata", scenario))); err != nil {
		t.Fatalf("copy fixture %s: %v", scenario, err)
	}
	for _, args := range [][]string{
		{"init", "-q"},
		{"add", "-A"},
		// Identity and signing pinned, so the commit does not depend on the
		// machine's git config: no identity, or a signing key that prompts.
		{"-c", "user.name=Pockode Eval", "-c", "user.email=eval@pockode.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Initial commit"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	return dir
}

// remainingFiles lists the repository's files after the turn, slash-separated
// and relative to it, leaving out git's own.
func remainingFiles(t *testing.T, dir string) map[string]bool {
	t.Helper()
	files := map[string]bool{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			files[filepath.ToSlash(rel)] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("list files after the turn: %v", err)
	}
	return files
}

// toolServer is the server end of the MCP proxy for one run: the real Executor,
// so question_post validates and replies exactly as it does in Pockode, over a
// session layer that records instead of showing a card.
type toolServer struct {
	dir string

	callsMu  sync.Mutex
	recorded []ToolCall
	exec     mcp.ToolExecutor
}

func startToolServer(t *testing.T, sessionID string) *toolServer {
	t.Helper()
	dir := t.TempDir()
	store, err := work.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("work store: %v", err)
	}
	// Only the question tools are wired: nothing in these scenarios is a work
	// item, and a call to anything else is recorded and refused (see Execute).
	s := &toolServer{
		dir:  dir,
		exec: mcp.NewExecutor(store, nil, nil, nil, nil, &recordingSessions{sessionID: sessionID}),
	}

	token := randomToken(t)
	mux := http.NewServeMux()
	mux.Handle(mcp.APIPath, mcp.NewAPIHandler(s, token))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	if err := serverinfo.Write(dir, 0, srv.URL, "", token); err != nil {
		t.Fatalf("write server.json: %v", err)
	}
	return s
}

func (s *toolServer) Execute(ctx context.Context, caller mcp.Caller, name string, args json.RawMessage) (text string, err error) {
	defer func() {
		// The tools this eval leaves unwired have nil stores behind them.
		if p := recover(); p != nil {
			err = fmt.Errorf("%s is not available in this session", name)
		}
		call := ToolCall{Tool: name, Arguments: args, Result: text}
		if err != nil {
			call.Error = err.Error()
		}
		s.callsMu.Lock()
		s.recorded = append(s.recorded, call)
		s.callsMu.Unlock()
	}()
	return s.exec.Execute(ctx, caller, name, args)
}

func (s *toolServer) calls() []ToolCall {
	s.callsMu.Lock()
	defer s.callsMu.Unlock()
	return slices.Clone(s.recorded)
}

func randomToken(t *testing.T) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

// recordingSessions is mcp.Sessions for one session that is only ever asked:
// every question posted is accepted and left unanswered, which is how a turn
// ends in Pockode when the user has not got to the card yet.
type recordingSessions struct {
	sessionID string

	questionsMu sync.Mutex
	open        map[string]bool
	next        int
}

func (s *recordingSessions) ResolveQuestions(string) (chat.Questions, func(), error) {
	return s, func() {}, nil
}

func (s *recordingSessions) SessionTurns(string) (map[string]session.TurnState, error) {
	return nil, nil
}

func (s *recordingSessions) LocateQuestions(requestID string) []worktree.QuestionLocation {
	s.questionsMu.Lock()
	defer s.questionsMu.Unlock()
	if !s.open[requestID] {
		return nil
	}
	return []worktree.QuestionLocation{{SessionID: s.sessionID}}
}

func (s *recordingSessions) ResolveSessionWorktree(string) (string, error) {
	return "", nil
}

func (s *recordingSessions) PostQuestions(_ context.Context, _ string, specs []chat.QuestionSpec) ([]session.PendingQuestion, error) {
	s.questionsMu.Lock()
	defer s.questionsMu.Unlock()
	if s.open == nil {
		s.open = map[string]bool{}
	}
	now := time.Now()
	posted := make([]session.PendingQuestion, len(specs))
	for i, spec := range specs {
		s.next++
		id := fmt.Sprintf("req-%d", s.next)
		s.open[id] = true
		posted[i] = session.PendingQuestion{
			RequestID:   id,
			Header:      spec.Header,
			Question:    spec.Question,
			Options:     spec.Options,
			MultiSelect: spec.MultiSelect,
			AskedAt:     now,
		}
	}
	return posted, nil
}

func (s *recordingSessions) CancelQuestion(_ context.Context, _, requestID string) error {
	s.questionsMu.Lock()
	defer s.questionsMu.Unlock()
	if !s.open[requestID] {
		return chat.ErrQuestionNotPending
	}
	delete(s.open, requestID)
	return nil
}

func (s *recordingSessions) AnswerQuestion(context.Context, string, chat.Answer, agent.QuestionResolver) error {
	return fmt.Errorf("nobody else asks anything in this session")
}
