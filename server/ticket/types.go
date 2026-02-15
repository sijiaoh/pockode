package ticket

import "time"

// TicketStatus represents the current state of a ticket.
type TicketStatus string

const (
	TicketStatusOpen       TicketStatus = "open"
	TicketStatusInProgress TicketStatus = "in_progress"
	TicketStatusDone       TicketStatus = "done"
)

// IsValid returns true if the status is one of the valid values.
func (s TicketStatus) IsValid() bool {
	switch s {
	case TicketStatusOpen, TicketStatusInProgress, TicketStatusDone:
		return true
	default:
		return false
	}
}

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

// RoleChangeEvent is emitted when a role changes.
type RoleChangeEvent struct {
	Op   Operation `json:"op"`
	Role AgentRole `json:"role"`
}

// OnRoleChangeListener receives role change notifications.
type OnRoleChangeListener interface {
	OnRoleChange(event RoleChangeEvent)
}

// BuildAgentSystemPrompt creates a system prompt for an agent working on a ticket.
func BuildAgentSystemPrompt(tk Ticket, role AgentRole) string {
	prompt := "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	prompt += " You are working on ticket: " + tk.ID + "\n\n"
	prompt += `When you have completed all tasks for this ticket, update its status to done using the ticket_update tool with status: "done".` + "\n"

	prompt += buildScopeConstraints()

	if role.SystemPrompt != "" {
		prompt += role.SystemPrompt + "\n"
	}

	if tk.Description != "" {
		prompt += tk.Description
	}

	return prompt
}

// buildScopeConstraints returns the scope constraints section for agent prompts.
func buildScopeConstraints() string {
	return `
## Scope Constraints

Work ONLY within the scope defined by this ticket's title and description.

**Do:**
- Complete tasks explicitly stated in the ticket
- Report out-of-scope issues without fixing them

**Do NOT:**
- Make changes unrelated to the ticket
- Refactor code not mentioned in the ticket
- Add "while I'm here" improvements

When uncertain whether something is in scope, do not proceed. If needed, suggest creating a new ticket.

`
}

// BuildAgentStartMessage creates a start message for an agent working on a ticket.
// Instead of embedding ticket data and role prompts directly in the system prompt,
// this message instructs the agent to fetch them dynamically using tools.
// This reduces context pressure and ensures the agent always sees the latest data.
func BuildAgentStartMessage(ticketID, rolePromptFilePath string) string {
	return "You are a Claude agent, built on Anthropic's Claude Agent SDK. You are working on ticket: " + ticketID + "\n\n" +
		`When you have completed all tasks for this ticket, update its status to done using the ticket_update tool with status: "done".` + "\n" +
		buildScopeConstraints() +
		"Before starting, read the role prompt from: " + rolePromptFilePath + "\n"
}
