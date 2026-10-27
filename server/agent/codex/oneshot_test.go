package codex

import (
	"errors"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
)

// Events as `codex exec --json` prints them on codex-cli 0.164.0, cut to the
// fields that are read.
func TestOneShotReader(t *testing.T) {
	const (
		started   = `{"type":"thread.started","thread_id":"t"}`
		turn      = `{"type":"turn.started"}`
		completed = `{"type":"turn.completed","usage":{"input_tokens":1}}`
		refused   = `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses`
	)

	tests := []struct {
		name    string
		lines   []string
		exit    agent.RunResult
		want    string
		wantErr func(error) bool
	}{
		{
			// Measured: told it may not use tools, the model still announces what
			// it is about to do before it answers.
			name: "the last agent message is the answer",
			lines: []string{
				started, turn,
				`{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll look at the diff.\n"}}`,
				`{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"..."}}`,
				`{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Add Div"}}`,
				completed,
			},
			want: "Add Div",
		},
		{
			name: "a warning about the CLI's own config is not a tool call",
			lines: []string{
				started,
				`{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting."}}`,
				turn,
				`{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Add Div"}}`,
				completed,
			},
			want: "Add Div",
		},
		{
			// The retries come first, each as a top-level error, for about 40s.
			name: "a 401 is an auth error",
			lines: []string{
				started, turn,
				`{"type":"error","message":"Reconnecting... 2/5 (` + refused + `)"}`,
				`{"type":"turn.failed","error":{"message":"` + refused + `"}}`,
			},
			wantErr: func(err error) bool {
				var authErr *agent.OneShotAuthError
				return errors.As(err, &authErr) && authErr.Message == refused
			},
		},
		{
			// update_plan writes only into the model's own context.
			name: "the model's plan is not a tool call that reaches anything",
			lines: []string{
				started, turn,
				`{"type":"item.started","item":{"id":"item_0","type":"todo_list","items":[]}}`,
				`{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Add Div"}}`,
				completed,
			},
			want: "Add Div",
		},
		{
			name:  "a failed turn that says nothing still says something",
			lines: []string{started, turn, `{"type":"turn.failed","error":{}}`},
			wantErr: func(err error) bool {
				var failed *agent.OneShotFailedError
				return errors.As(err, &failed) && failed.Message != ""
			},
		},
		{
			name:  "any other failed turn carries what the CLI said",
			lines: []string{started, turn, `{"type":"turn.failed","error":{"message":"The 'gpt-6' model requires a newer version of Codex."}}`},
			wantErr: func(err error) bool {
				var failed *agent.OneShotFailedError
				return errors.As(err, &failed) && failed.Message == "The 'gpt-6' model requires a newer version of Codex."
			},
		},
		{
			name: "an exit before the turn ends reads stderr",
			exit: agent.RunResult{ExitCode: 1, Stderr: "Error: unexpected argument '--ignore-user-config' found\n"},
			wantErr: func(err error) bool {
				var failed *agent.OneShotFailedError
				return errors.As(err, &failed) && strings.Contains(failed.Message, "--ignore-user-config")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var r oneShotReader
			for _, line := range tt.lines {
				if err := r.line([]byte(line)); err != nil {
					t.Fatalf("line(%s) = %v", line, err)
				}
			}
			got, err := r.answer(tt.exit)
			if tt.wantErr != nil {
				if !tt.wantErr(err) {
					t.Fatalf("answer() error = %v (%T)", err, err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("answer() = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

// Codex cannot be told to have no tools, so a run that reports one is stopped
// the moment it does — on item.started, before the call has a result.
func TestOneShotReader_StopsAtToolUse(t *testing.T) {
	for _, item := range []string{"command_execution", "file_change", "mcp_tool_call", "web_search", "a_tool_added_later"} {
		t.Run(item, func(t *testing.T) {
			var r oneShotReader
			err := r.line([]byte(`{"type":"item.started","item":{"id":"item_0","type":"` + item + `"}}`))
			if !errors.Is(err, agent.ErrOneShotToolUse) {
				t.Fatalf("got %v, want ErrOneShotToolUse", err)
			}
		})
	}
}

// The fields the tool check reads must decode. A later CLI version that
// changed their shape would otherwise have every event skipped, tool calls
// included, and the run let through.
func TestOneShotReader_FailsClosedOnAnUnreadableItem(t *testing.T) {
	var r oneShotReader
	err := r.line([]byte(`{"type":"item.started","item":{"id":"item_0","type":{"kind":"command_execution"}}}`))
	var failed *agent.OneShotFailedError
	if !errors.As(err, &failed) {
		t.Fatalf("got %v, want the run stopped", err)
	}
}
