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
	agent.RunIntegrationTests(t, newCodexAgent, agent.IntegrationTestOptions{
		SkipEvents: []agent.EventType{agent.EventTypeAskUserQuestion},
	})
}
