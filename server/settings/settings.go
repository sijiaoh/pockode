// Package settings provides server-side settings management.
package settings

type Settings struct {
	DefaultAgentRoleID string `json:"default_agent_role_id,omitempty"`
}

func Default() Settings {
	return Settings{}
}
