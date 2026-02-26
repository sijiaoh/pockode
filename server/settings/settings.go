// Package settings provides server-side settings management.
package settings

import "github.com/pockode/server/session"

type Settings struct {
	DefaultAgentRoleID string       `json:"default_agent_role_id,omitempty"`
	DefaultMode        session.Mode `json:"default_mode,omitempty"`
}

func Default() Settings {
	return Settings{}
}
