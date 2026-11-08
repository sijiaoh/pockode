package codex

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"strings"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// oneShotArgs runs a single prompt read from stdin through `codex exec`,
// not app-server: there is no thread to keep, and exec is the CLI's own
// one-prompt mode.
//
// Codex has no switch that takes every tool away — asked to name its tools on
// codex-cli 0.164.0 with all of the below, the model still lists apply_patch,
// view_image, its code-mode exec and the MCP resource readers. So the flags do
// two things. They remove what can be removed: the shell, web search, the
// features that bring tools of their own, and the MCP servers of the user's
// config.toml. And they make what is left unable to change anything: a
// read-only sandbox with approvals off, so a write is refused without anyone
// being asked — measured: told to create a file with apply_patch, it answers
// that the sandbox is read-only and nothing is written. oneShotReader then
// refuses any run in which a tool call was reported.
//
// What a read-only sandbox does not stop is reading: view_image and code-mode
// exec can still read files the user can, and code mode's calls are not
// reported as items. A prompt injected through the diff could have the model
// quote such a file into its answer. The answer only reaches the commit
// sheet's text box, where the user reads it before committing, and the model
// provider, which a codex session in the same project is sent as much; still,
// this is the gap between codex and the "no tools" a claude one-shot has.
//
// Feature switches go through -c rather than --disable: --disable fails the
// whole run on a name the installed version does not know, while an unknown
// key under -c is ignored, and features come and go between releases. Values
// are bare words rather than TOML strings because a double quote cannot pass
// through the .cmd wrapper npm installs on Windows (see agent.checkCmdSafe);
// -c reads a value that is not valid TOML as a literal string.
//
// MCP servers are why the user's config.toml is not read at all
// (--ignore-user-config; sign-in is kept, it lives beside the file, not in
// it). `-c mcp_servers={}` does not remove them — -c merges into the table
// rather than replacing it, measured on 0.164.0 — and an MCP server runs
// outside the sandbox, so its tools are the ones that could reach something.
// The price is the user's model and provider settings: the model is the one
// the request names, or the CLI's default.
var oneShotArgs = func() []string {
	args := []string{
		"exec",
		"--json",
		"--color", "never",
		"--ephemeral",
		"--skip-git-repo-check",
		"--sandbox", "read-only",
		"-c", "approval_policy=never",
		"-c", "web_search=disabled",
		"--ignore-user-config",
	}
	for _, feature := range []string{
		"shell_tool", "apps", "plugins", "multi_agent", "multi_agent_v2",
		"image_generation", "browser_use", "computer_use", "in_app_browser",
		"goals", "memories",
	} {
		args = append(args, "-c", "features."+feature+"=false")
	}
	return args
}()

var _ agent.OneShotRunner = (*Agent)(nil)

// RunOneShot implements agent.OneShotRunner.
func (a *Agent) RunOneShot(ctx context.Context, req agent.OneShotRequest) (string, error) {
	log := slog.With("cli", Binary, "purpose", "one-shot")
	args := slices.Clone(oneShotArgs)
	if req.Model != "" {
		args = append(args, "--model", req.Model)
	}
	// What a session sends as the thread's model_reasoning_effort override.
	if req.Effort != "" {
		args = append(args, "-c", "model_reasoning_effort="+req.Effort)
	}
	// The prompt is read from stdin.
	args = append(args, "-")
	var reader oneShotReader
	res, err := agent.RunStream(ctx, log, Binary, req.WorkDir, args, req.Prompt, reader.line)
	if err != nil {
		return "", err
	}
	return reader.answer(res)
}

// oneShotReader reads the `codex exec --json` event stream of a one-shot run.
type oneShotReader struct {
	completed bool
	failed    bool
	failure   string
	// lastError is the latest top-level error event: a retry notice while the
	// turn goes on, and the only account there is if the CLI exits before
	// saying how the turn ended.
	lastError string
	// message is the latest agent message. The model may say what it is about
	// to do before it answers, so the answer is the last one.
	message string
}

// oneShotItemTypes are the items a tool-free answer is made of. Every other
// item type — command_execution, file_change, mcp_tool_call, web_search,
// collab_tool_call and whatever a later version adds — is the record of a
// tool call that can reach outside the model.
var oneShotItemTypes = map[string]bool{
	"agent_message": true,
	"reasoning":     true,
	// Warnings the CLI raises about its own setup, such as a config key it
	// ignores.
	"error": true,
	// The model's own plan (update_plan). A tool by name, but one that only
	// writes into the model's context, and there is no switch for it: refusing
	// it would fail a paid run for a model that likes to plan first.
	"todo_list": true,
}

// line reads one event. What says whether the event is a tool call — its type
// and its item's type — is decoded on its own and must decode; the rest is
// read leniently, so a field changing shape in a later CLI version costs that
// field and not the check.
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
	case "item.started", "item.updated", "item.completed":
		var event struct {
			Item struct {
				Type string `json:"type"`
			} `json:"item"`
		}
		if err := json.Unmarshal(line, &event); err != nil {
			return agent.OneShotUnreadableError(Binary, err)
		}
		if !oneShotItemTypes[event.Item.Type] {
			return agent.ErrOneShotToolUse
		}
		if head.Type == "item.completed" && event.Item.Type == "agent_message" {
			var message struct {
				Item struct {
					Text string `json:"text"`
				} `json:"item"`
			}
			if json.Unmarshal(line, &message) == nil {
				r.message = message.Item.Text
			}
		}
	case "error":
		var event struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(line, &event) == nil {
			r.lastError = event.Message
		}
	case "turn.failed":
		var event struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(line, &event)
		r.failed = true
		r.failure = event.Error.Message
		if r.failure == "" {
			r.failure = "codex reported a failed turn without saying why"
		}
	case "turn.completed":
		r.completed = true
	}
	return nil
}

// isAuthRefusal reads a turn failure's message for a refused credential.
// Measured on codex-cli 0.164.0 signed out: the turn fails with "unexpected
// status 401 Unauthorized: Missing bearer or basic authentication in header,
// ...". exec reports no structured codexErrorInfo the way app-server does (see
// readAuthVerdict), so the status in the text is all there is.
func isAuthRefusal(message string) bool {
	return strings.Contains(message, "401 Unauthorized")
}

func (r *oneShotReader) answer(res agent.RunResult) (string, error) {
	switch {
	case r.failed:
		if isAuthRefusal(r.failure) {
			return "", &agent.OneShotAuthError{Agent: session.AgentTypeCodex, Message: r.failure}
		}
		return "", &agent.OneShotFailedError{Message: r.failure}
	case r.completed:
		return r.message, nil
	case r.lastError != "":
		if isAuthRefusal(r.lastError) {
			return "", &agent.OneShotAuthError{Agent: session.AgentTypeCodex, Message: r.lastError}
		}
		return "", &agent.OneShotFailedError{Message: r.lastError}
	default:
		return "", agent.OneShotExitError(Binary, res)
	}
}
