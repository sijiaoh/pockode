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
	// AskUserQuestion has no Codex counterpart over MCP: Codex asks through
	// elicitation, which only carries approvals, and its request_user_input
	// event is not served by the MCP server.
	//
	// DenyEndsInterrupted stays off on purpose: a denied approval means "do not
	// run this, try something else" for Codex, so the turn continues and ends
	// with a normal done event.
	agent.RunIntegrationTests(t, newCodexAgent, agent.IntegrationTestOptions{
		SkipEvents: []agent.EventType{agent.EventTypeAskUserQuestion},
	})
}
