package agent

import "encoding/json"

// EventType defines the type of agent event.
type EventType string

const (
	EventTypeText              EventType = "text"
	EventTypeToolCall          EventType = "tool_call"
	EventTypeToolResult        EventType = "tool_result"
	EventTypeError             EventType = "error"
	EventTypeDone              EventType = "done"
	EventTypeInterrupted       EventType = "interrupted"
	EventTypePermissionRequest EventType = "permission_request"
	EventTypeAskUserQuestion   EventType = "ask_user_question"
	EventTypeSystem            EventType = "system"
	EventTypeProcessEnded      EventType = "process_ended"
)

// PermissionBehavior represents the permission action.
type PermissionBehavior string

const (
	PermissionBehaviorAllow PermissionBehavior = "allow"
	PermissionBehaviorDeny  PermissionBehavior = "deny"
	PermissionBehaviorAsk   PermissionBehavior = "ask"
)

// PermissionUpdateDestination represents where the permission update is stored.
type PermissionUpdateDestination string

const (
	PermissionDestinationUserSettings    PermissionUpdateDestination = "userSettings"
	PermissionDestinationProjectSettings PermissionUpdateDestination = "projectSettings"
	PermissionDestinationLocalSettings   PermissionUpdateDestination = "localSettings"
	PermissionDestinationSession         PermissionUpdateDestination = "session"
)

// PermissionUpdateType represents the type of permission update.
type PermissionUpdateType string

const (
	PermissionUpdateAddRules          PermissionUpdateType = "addRules"
	PermissionUpdateReplaceRules      PermissionUpdateType = "replaceRules"
	PermissionUpdateRemoveRules       PermissionUpdateType = "removeRules"
	PermissionUpdateSetMode           PermissionUpdateType = "setMode"
	PermissionUpdateAddDirectories    PermissionUpdateType = "addDirectories"
	PermissionUpdateRemoveDirectories PermissionUpdateType = "removeDirectories"
)

// PermissionMode represents the permission mode for setMode updates.
type PermissionMode string

const (
	PermissionModeDefault           PermissionMode = "default"
	PermissionModeAcceptEdits       PermissionMode = "acceptEdits"
	PermissionModeBypassPermissions PermissionMode = "bypassPermissions"
	PermissionModePlan              PermissionMode = "plan"
)

// PermissionRuleValue represents a single permission rule.
type PermissionRuleValue struct {
	ToolName    string `json:"toolName"`
	RuleContent string `json:"ruleContent,omitempty"`
}

// PermissionUpdate represents a permission update operation.
type PermissionUpdate struct {
	Type        PermissionUpdateType        `json:"type"`
	Behavior    PermissionBehavior          `json:"behavior,omitempty"`
	Destination PermissionUpdateDestination `json:"destination"`
	Rules       []PermissionRuleValue       `json:"rules,omitempty"`
	Mode        PermissionMode              `json:"mode,omitempty"`
	Directories []string                    `json:"directories,omitempty"`
}

// QuestionOption represents a single option for a user question.
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

// AskUserQuestion represents a question to ask the user.
type AskUserQuestion struct {
	Question    string           `json:"question"`
	Header      string           `json:"header"`
	Options     []QuestionOption `json:"options"`
	MultiSelect bool             `json:"multiSelect"`
}

// AgentEvent represents a unified event from an AI agent.
type AgentEvent struct {
	Type                  EventType          `json:"type"`
	Content               string             `json:"content,omitempty"`
	ToolName              string             `json:"tool_name,omitempty"`
	ToolInput             json.RawMessage    `json:"tool_input,omitempty"`
	ToolUseID             string             `json:"tool_use_id,omitempty"`
	ToolResult            string             `json:"tool_result,omitempty"`
	Error                 string             `json:"error,omitempty"`
	RequestID             string             `json:"request_id,omitempty"`
	PermissionSuggestions []PermissionUpdate `json:"permission_suggestions,omitempty"`
	Questions             []AskUserQuestion  `json:"questions,omitempty"`
}
