//go:build integration

package claude

import (
	"context"
	"os/exec"
	"testing"
	"time"

	"github.com/pockode/server/agent"
)

// Integration tests for Claude CLI.
// These tests call real Claude CLI and consume API tokens.
//
// Run manually with: go test -tags=integration ./agent/claude -v -run Integration
//
// Prerequisites:
//   - claude CLI installed and in PATH
//   - Valid API credentials configured

func TestIntegration_ClaudeCliAvailable(t *testing.T) {
	_, err := exec.LookPath(Binary)
	if err != nil {
		t.Fatalf("claude CLI not found in PATH: %v", err)
	}
}

func TestIntegration_SimplePrompt(t *testing.T) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	session, err := a.Start(ctx, t.TempDir(), "")
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	// Send the first message
	if err := session.SendMessage("Reply with exactly: OK"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var textEvents, doneEvents, sessionEvents int

eventLoop:
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				break eventLoop
			}
			switch event.Type {
			case agent.EventTypeSession:
				sessionEvents++
				t.Logf("session: %s", event.SessionID)
			case agent.EventTypeText:
				textEvents++
				t.Logf("text: %s", event.Content)
			case agent.EventTypeDone:
				doneEvents++
				break eventLoop // Message complete, exit loop
			case agent.EventTypeError:
				t.Errorf("error event: %s", event.Error)
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	if sessionEvents == 0 {
		t.Error("expected at least one session event")
	}
	if textEvents == 0 {
		t.Error("expected at least one text event")
	}
	if doneEvents != 1 {
		t.Errorf("expected exactly 1 done event, got %d", doneEvents)
	}
}

func TestIntegration_PermissionFlow(t *testing.T) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	session, err := a.Start(ctx, t.TempDir(), "")
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	// Use a command that will definitely require permission (not pre-approved)
	// Ruby version check is a good candidate as it's not a common pre-approved command
	if err := session.SendMessage("Run this exact command and show output: ruby --version"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var toolCalls, toolResults, errorEvents, permissionRequests int

eventLoop:
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				break eventLoop
			}
			switch event.Type {
			case agent.EventTypeToolCall:
				toolCalls++
				t.Logf("tool_call: %s (id=%s)", event.ToolName, event.ToolUseID)
			case agent.EventTypeToolResult:
				toolResults++
				t.Logf("tool_result: id=%s, content=%s", event.ToolUseID, event.ToolResult[:min(100, len(event.ToolResult))])
			case agent.EventTypePermissionRequest:
				permissionRequests++
				t.Logf("permission_request: %s (request_id=%s)", event.ToolName, event.RequestID)
				if event.RequestID == "" {
					t.Error("permission_request missing RequestID")
				}
				if event.ToolName == "" {
					t.Error("permission_request missing ToolName")
				}
				// Auto-approve for integration test
				if err := session.SendPermissionResponse(event.RequestID, true); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case agent.EventTypeError:
				errorEvents++
				t.Logf("error: %s", event.Error)
			case agent.EventTypeText:
				t.Logf("text: %s", event.Content[:min(100, len(event.Content))])
			case agent.EventTypeDone:
				break eventLoop // Message complete
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	t.Logf("summary: permission_requests=%d, tool_calls=%d, tool_results=%d, errors=%d",
		permissionRequests, toolCalls, toolResults, errorEvents)

	// With --permission-prompt-tool stdio, we MUST get permission requests
	if permissionRequests == 0 {
		t.Error("expected at least one permission_request event - permission flow not triggered")
	}

	// After approval, tool should execute
	if permissionRequests > 0 && toolResults == 0 {
		t.Error("permission was approved but no tool_result received")
	}
}
