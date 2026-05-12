//go:build integration

package claude

import (
	"os/exec"
	"testing"

	"github.com/pockode/server/agent"
)

func TestIntegration_ClaudeCliAvailable(t *testing.T) {
	_, err := exec.LookPath(Binary)
	if err != nil {
		t.Fatalf("claude CLI not found in PATH: %v", err)
	}
}

func TestIntegration(t *testing.T) {
	agent.RunIntegrationTests(t, func() agent.Agent { return New() }, agent.IntegrationTestOptions{})
}
