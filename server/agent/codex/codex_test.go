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
	// AskUserQuestion is not wired up for Codex. The app-server channel does have
	// a counterpart — `item/tool/requestUserInput` — but it is marked
	// EXPERIMENTAL in the protocol schema and handleRequestUserInput declines it
	// rather than asking the user; see the comment there.
	//
	// DenyEndsInterrupted stays off on purpose: a denied approval is answered
	// with `decline`, which means "do not run this, try something else", so the
	// turn continues and ends with a normal done event. (`cancel` is the
	// decision that would end it, and it is reserved for interrupts.)
	agent.RunIntegrationTests(t, newCodexAgent, agent.IntegrationTestOptions{
		SkipEvents: []agent.EventType{agent.EventTypeAskUserQuestion},
	})
}
