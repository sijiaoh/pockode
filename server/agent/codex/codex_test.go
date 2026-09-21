//go:build integration

package codex

import (
	"testing"

	"github.com/pockode/server/agent"
)

func newCodexAgent() agent.Agent {
	return New()
}

func TestCodexIntegration(t *testing.T) {
	// AskUserQuestion is not wired up for Codex, and is not going to be: the
	// app-server counterpart — `item/tool/requestUserInput` — is refused by
	// handleRequestUserInput, which tells the agent to use question_post. The
	// shared suite's CLIQuestionNeverReachesTheUser covers that end of it.
	//
	// DenyEndsInterrupted stays off on purpose: a denied approval is answered
	// with `decline`, which means "do not run this, try something else", so the
	// turn continues and ends with a normal done event. (`cancel` is the
	// decision that would end it, and it is reserved for interrupts.)
	agent.RunIntegrationTests(t, newCodexAgent, agent.IntegrationTestOptions{})
}
