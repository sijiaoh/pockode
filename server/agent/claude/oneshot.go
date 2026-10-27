package claude

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"strings"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// oneShotArgs runs a single prompt read from stdin with nothing the model
// could reach the project through. Measured on claude 2.1.311:
//
//   - `--tools ""` removes every built-in tool — asked to name its tools, the
//     model answers that it has none.
//   - --strict-mcp-config with no --mcp-config drops the MCP servers of the
//     user's and the project's settings, whose tools --tools does not cover.
//   - --disable-slash-commands keeps skills out of the tool list as well.
//
// --bare would go further but cannot be used: it reads credentials from
// ANTHROPIC_API_KEY alone, so a CLI signed in with OAuth fails under it.
// stream-json rather than json because only it marks an auth refusal as such
// (the assistant frame's `error`), and because a tool call shows up in it
// while the run is still going.
var oneShotArgs = []string{
	"--print",
	"--output-format", "stream-json",
	"--verbose",
	"--tools", "",
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--no-session-persistence",
}

var _ agent.OneShotRunner = (*Agent)(nil)

// RunOneShot implements agent.OneShotRunner.
func (a *Agent) RunOneShot(ctx context.Context, req agent.OneShotRequest) (string, error) {
	log := slog.With("cli", Binary, "purpose", "one-shot")
	args := slices.Clone(oneShotArgs)
	// The same flags a session takes its model and effort from (buildArgs).
	if req.Model != "" {
		args = append(args, "--model", req.Model)
	}
	if req.Effort != "" {
		args = append(args, "--effort", req.Effort)
	}
	var reader oneShotReader
	res, err := agent.RunStream(ctx, log, Binary, req.WorkDir, args, req.Prompt, reader.line)
	if err != nil {
		return "", err
	}
	return reader.answer(res)
}

// oneShotReader reads the stream-json output of a one-shot run.
type oneShotReader struct {
	authFailed bool
	ended      bool
	isError    bool
	result     string
}

// line reads one frame. What says whether the frame is a tool call — its type
// and its content blocks' types — is decoded on its own and must decode; the
// rest is read leniently, so a field changing shape in a later CLI version
// costs that field and not the check.
func (r *oneShotReader) line(line []byte) error {
	if !json.Valid(line) {
		return nil
	}
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		return agent.OneShotUnreadableError(Binary, err)
	}
	switch head.Type {
	case "assistant":
		var blocks struct {
			Message struct {
				Content []struct {
					Type string `json:"type"`
				} `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(line, &blocks); err != nil {
			return agent.OneShotUnreadableError(Binary, err)
		}
		for _, block := range blocks.Message.Content {
			// server_tool_use is a tool the API runs itself (web search); it is
			// as much a tool as one the CLI runs.
			if block.Type == "tool_use" || block.Type == "server_tool_use" {
				return agent.ErrOneShotToolUse
			}
		}
		var frame struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(line, &frame) == nil && frame.Error == authFailedError {
			r.authFailed = true
		}
	case "result":
		var frame struct {
			IsError bool   `json:"is_error"`
			Result  string `json:"result"`
		}
		// An unreadable result still ends the run; answer reports it as one
		// without an answer.
		_ = json.Unmarshal(line, &frame)
		r.ended = true
		r.isError = frame.IsError
		r.result = frame.Result
	}
	return nil
}

func (r *oneShotReader) answer(res agent.RunResult) (string, error) {
	if !r.ended {
		return "", agent.OneShotExitError(Binary, res)
	}
	if r.authFailed {
		return "", &agent.OneShotAuthError{Agent: session.AgentTypeClaude, Message: r.result}
	}
	if r.isError {
		msg := strings.TrimSpace(r.result)
		if msg == "" {
			msg = "claude reported an error without saying what it was"
		}
		return "", &agent.OneShotFailedError{Message: msg}
	}
	return r.result, nil
}
