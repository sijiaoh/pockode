package claude

import (
	"errors"
	"testing"

	"github.com/pockode/server/agent"
)

// Frames as claude 2.1.311 prints them under oneShotArgs, cut to the fields
// that are read.
func TestOneShotReader(t *testing.T) {
	const (
		initFrame = `{"type":"system","subtype":"init"}`
		answered  = `{"type":"assistant","message":{"content":[{"type":"text","text":"Add Div"}]}}`
		result    = `{"type":"result","subtype":"success","is_error":false,"result":"Add Div"}`
	)

	tests := []struct {
		name    string
		lines   []string
		exit    agent.RunResult
		want    string
		wantErr func(error) bool
	}{
		{
			name:  "the result is the answer",
			lines: []string{initFrame, answered, `{"type":"rate_limit_event"}`, result},
			want:  "Add Div",
		},
		{
			name: "a refused sign-in is an auth error, not a failure",
			lines: []string{
				initFrame,
				`{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]}}`,
				`{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","terminal_reason":"api_error"}`,
			},
			wantErr: func(err error) bool {
				var authErr *agent.OneShotAuthError
				return errors.As(err, &authErr) && authErr.Message == "Not logged in · Please run /login"
			},
		},
		{
			name:  "an error result carries what the CLI said",
			lines: []string{initFrame, `{"type":"result","is_error":true,"result":"API Error: 529 overloaded"}`},
			wantErr: func(err error) bool {
				var failed *agent.OneShotFailedError
				return errors.As(err, &failed) && failed.Message == "API Error: 529 overloaded"
			},
		},
		{
			name:  "an exit before any result reads stderr",
			lines: []string{initFrame},
			exit:  agent.RunResult{ExitCode: 1, Stderr: "error: unknown option '--tools'\n"},
			wantErr: func(err error) bool {
				var failed *agent.OneShotFailedError
				return errors.As(err, &failed) && failed.Message == "claude exited with status 1 without an answer: error: unknown option '--tools'"
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

func TestOneShotReader_StopsAtToolUse(t *testing.T) {
	for _, block := range []string{"tool_use", "server_tool_use"} {
		t.Run(block, func(t *testing.T) {
			var r oneShotReader
			err := r.line([]byte(`{"type":"assistant","message":{"content":[{"type":"` + block + `","name":"Bash"}]}}`))
			if !errors.Is(err, agent.ErrOneShotToolUse) {
				t.Fatalf("got %v, want ErrOneShotToolUse", err)
			}
		})
	}
}

// The fields the tool check reads must decode, while the others may change
// shape without stopping the run.
func TestOneShotReader_FailsClosedOnUnreadableContent(t *testing.T) {
	var r oneShotReader
	err := r.line([]byte(`{"type":"assistant","message":{"content":"tool_use"}}`))
	var failed *agent.OneShotFailedError
	if !errors.As(err, &failed) {
		t.Fatalf("got %v, want the run stopped", err)
	}

	r = oneShotReader{}
	if err := r.line([]byte(`{"type":"assistant","error":{"code":"x"},"message":{"content":[{"type":"text"}]}}`)); err != nil {
		t.Fatalf("a reshaped field the check does not read stopped the run: %v", err)
	}
}
