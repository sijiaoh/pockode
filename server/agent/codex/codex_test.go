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
	//
	// StreamsCommandOutput is on because the app-server streams a running
	// command's stdout as `item/commandExecution/outputDelta`, which
	// handleCommandOutputDelta turns into the tool activity the UI's
	// long-running row reads. Nothing persists that event, so the shared chat
	// scenario is what keeps a renamed field from going unnoticed — and that is
	// also why the flag makes that scenario run a command that prints over
	// several seconds: a command already finished when the app-server reports it
	// is delivered whole on `item/completed`, with no delta to rename.
	agent.RunIntegrationTests(t, newCodexAgent, agent.IntegrationTestOptions{
		ForkedSessions:       checkForkedSessions,
		StreamsCommandOutput: true,
	})
}
