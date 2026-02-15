package ticket

import (
	"strings"
	"testing"
)

func TestTicketStatus_IsValid(t *testing.T) {
	tests := []struct {
		status TicketStatus
		want   bool
	}{
		{TicketStatusOpen, true},
		{TicketStatusInProgress, true},
		{TicketStatusDone, true},
		{"invalid", false},
		{"", false},
		{"OPEN", false},
		{"pending", false},
	}

	for _, tt := range tests {
		t.Run(string(tt.status), func(t *testing.T) {
			if got := tt.status.IsValid(); got != tt.want {
				t.Errorf("TicketStatus(%q).IsValid() = %v, want %v", tt.status, got, tt.want)
			}
		})
	}
}

func TestBuildAgentSystemPrompt(t *testing.T) {
	tk := Ticket{
		ID:          "test-ticket-id",
		Description: "Test description",
	}
	role := AgentRole{
		SystemPrompt: "You are a test agent.",
	}

	prompt := BuildAgentSystemPrompt(tk, role)

	if !strings.Contains(prompt, "test-ticket-id") {
		t.Error("prompt should contain ticket ID")
	}
	if !strings.Contains(prompt, "ticket_update") {
		t.Error("prompt should contain ticket_update instruction")
	}
	if !strings.Contains(prompt, "Scope Constraints") {
		t.Error("prompt should contain scope constraints")
	}
	if !strings.Contains(prompt, "You are a test agent.") {
		t.Error("prompt should contain role system prompt")
	}
	if !strings.Contains(prompt, "Test description") {
		t.Error("prompt should contain ticket description")
	}
}

func TestBuildAgentSystemPrompt_EmptyRole(t *testing.T) {
	tk := Ticket{
		ID:          "test-ticket-id",
		Description: "Test description",
	}
	role := AgentRole{}

	prompt := BuildAgentSystemPrompt(tk, role)

	if !strings.Contains(prompt, "test-ticket-id") {
		t.Error("prompt should contain ticket ID")
	}
	if !strings.Contains(prompt, "Scope Constraints") {
		t.Error("prompt should contain scope constraints")
	}
	if !strings.Contains(prompt, "Test description") {
		t.Error("prompt should contain ticket description")
	}
}

func TestBuildAgentSystemPrompt_EmptyDescription(t *testing.T) {
	tk := Ticket{
		ID: "test-ticket-id",
	}
	role := AgentRole{
		SystemPrompt: "You are a test agent.",
	}

	prompt := BuildAgentSystemPrompt(tk, role)

	if !strings.Contains(prompt, "test-ticket-id") {
		t.Error("prompt should contain ticket ID")
	}
	if !strings.Contains(prompt, "Scope Constraints") {
		t.Error("prompt should contain scope constraints")
	}
	if !strings.Contains(prompt, "You are a test agent.") {
		t.Error("prompt should contain role system prompt")
	}
}
