// Package settings provides server-side settings management.
package settings

import "errors"

// ErrInvalidSandboxMode is returned when a sandbox mode value is not recognized.
var ErrInvalidSandboxMode = errors.New("invalid sandbox mode")

// SandboxMode determines how Claude CLI is executed.
type SandboxMode string

const (
	// SandboxModeHost uses the local claude command directly (default).
	SandboxModeHost SandboxMode = "host"
	// SandboxModeYoloOnly uses Docker sandbox only for YOLO mode.
	SandboxModeYoloOnly SandboxMode = "yolo_only"
	// SandboxModeAlways always uses Docker sandbox.
	SandboxModeAlways SandboxMode = "always"
)

func (m SandboxMode) IsValid() bool {
	switch m {
	case SandboxModeHost, SandboxModeYoloOnly, SandboxModeAlways:
		return true
	default:
		return false
	}
}

type Settings struct {
	Sandbox SandboxMode `json:"sandbox"`
}

func (s Settings) Validate() error {
	if !s.Sandbox.IsValid() {
		return ErrInvalidSandboxMode
	}
	return nil
}

func Default() Settings {
	return Settings{
		Sandbox: SandboxModeHost,
	}
}
