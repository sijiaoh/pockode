package ticket

import "time"

// TicketStatus represents the current state of a ticket.
type TicketStatus string

const (
	TicketStatusOpen       TicketStatus = "open"
	TicketStatusInProgress TicketStatus = "in_progress"
	TicketStatusDone       TicketStatus = "done"
)

// Ticket represents a task for an agent to work on.
type Ticket struct {
	ID          string       `json:"id"`
	ParentID    string       `json:"parent_id,omitempty"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	RoleID      string       `json:"role_id"`
	Status      TicketStatus `json:"status"`
	Priority    int          `json:"priority"`
	SessionID   string       `json:"session_id,omitempty"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
}

// AgentRole defines a role with its system prompt.
type AgentRole struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	SystemPrompt string `json:"system_prompt"`
}

// Operation represents the type of change to a ticket.
type Operation string

const (
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

// TicketChangeEvent is emitted when a ticket changes.
type TicketChangeEvent struct {
	Op     Operation `json:"op"`
	Ticket Ticket    `json:"ticket"`
}

// OnChangeListener receives ticket change notifications.
type OnChangeListener interface {
	OnTicketChange(event TicketChangeEvent)
}

// BuildAgentSystemPrompt creates a system prompt for an agent working on a ticket.
func BuildAgentSystemPrompt(tk Ticket, role AgentRole) string {
	prompt := "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	prompt += " You are working on ticket: " + tk.ID + "\n\n"
	prompt += `When you have completed all tasks for this ticket, update its status to done using the ticket_update tool with status: "done".` + "\n"

	if role.SystemPrompt != "" {
		prompt += role.SystemPrompt + "\n"
	}

	if tk.Description != "" {
		prompt += tk.Description
	}

	return prompt
}
