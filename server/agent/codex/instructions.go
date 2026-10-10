package codex

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/pockode/server/agent"
)

// Codex has no channel of its own for Pockode's guidance that it shows
// before a tool is loaded: an MCP server's instructions only become the
// description of its tool namespace once the model has searched for one of its
// tools (codex-cli 0.159.3). The thread's developer instructions are seen from
// the first turn, so the guidance goes there.
//
// Two measured facts (0.159.3) shape how:
//   - developerInstructions replaces the user's own developer_instructions
//     rather than adding to it: with both set, only the parameter reached the
//     model. So the user's value is read first and sent ahead of the guidance.
//   - They are fixed when the thread starts. thread/resume and thread/fork
//     ignore the parameter and keep what the thread started with, so it is sent
//     on thread/start alone — and a thread started before the guidance existed,
//     or before a change to it, goes on without it.

// developerInstructions is the user's own developer_instructions for this
// working directory, if any, followed by Pockode's guidance.
func (s *appSession) developerInstructions(ctx context.Context) string {
	user, err := s.readUserDeveloperInstructions(ctx)
	// Not reading them is not a reason to refuse the session: the user is told
	// instead, since their instructions are what goes missing. Unless the
	// budget ran out or the process is gone — then the thread/start is about to
	// fail for the same reason, and that is the error worth reporting.
	if err != nil && ctx.Err() == nil {
		s.log.Warn("could not read codex developer_instructions", "error", err)
		s.emitEvent(agent.WarningEvent{
			Message: fmt.Sprintf("Could not read developer_instructions from your Codex config (%s). If you set any, this session runs without them.", err),
			Code:    "codex_config_unreadable",
		})
	}

	if user == "" {
		return agent.Guidance
	}
	return user + "\n\n" + agent.Guidance
}

// readUserDeveloperInstructions asks Codex for the developer_instructions its
// config layers resolve to in this working directory, project layers included.
func (s *appSession) readUserDeveloperInstructions(ctx context.Context) (string, error) {
	result, err := s.sendRPC(ctx, "config/read", map[string]interface{}{"cwd": s.opts.WorkDir})
	if err != nil {
		return "", err
	}
	var parsed struct {
		Config struct {
			DeveloperInstructions *string `json:"developer_instructions"`
		} `json:"config"`
	}
	if err := json.Unmarshal(result, &parsed); err != nil {
		return "", fmt.Errorf("parse config/read reply: %w", err)
	}
	if parsed.Config.DeveloperInstructions == nil {
		return "", nil
	}
	return *parsed.Config.DeveloperInstructions, nil
}
