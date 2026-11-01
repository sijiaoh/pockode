// Package node provides Node management for cluster mode.
// A Node represents a project directory that can run Pockode.
package node

import (
	"errors"
	"time"
)

// Node represents a project directory that can be managed by Pockode cluster.
type Node struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"` // Absolute path to project directory
	Name      string    `json:"name"` // Display name
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// LastUsedAt is when the user last acted on this node — edited or started
	// it — and is what the node list sorts on, newest first. It is deliberately
	// not UpdatedAt: that one means "the record was modified", and folding a
	// start into it would make the name lie about a node whose stored fields
	// never changed.
	LastUsedAt time.Time `json:"last_used_at"`
}

var (
	ErrNodeNotFound  = errors.New("node not found")
	ErrInvalidNode   = errors.New("invalid node")
	ErrDuplicatePath = errors.New("duplicate path")
)

// Status represents the running state of a node's server.
type Status string

const (
	// StatusRunning indicates server.json exists and the PID process is alive.
	StatusRunning Status = "running"
	// StatusStopped indicates server.json does not exist.
	StatusStopped Status = "stopped"
	// StatusStale indicates server.json exists but the PID process is not running.
	StatusStale Status = "stale"
	// StatusRestarting is a node this cluster asked to restart whose successor
	// has not written its server.json yet, for at most restartTimeout. It is the
	// cluster's state, not the files': they may say running (the old start),
	// stopped (Windows, between the old file and the new) or stale.
	StatusRestarting Status = "restarting"
)

// NodeStatus contains the status information of a node.
type NodeStatus struct {
	ID        string  `json:"id"`
	Status    Status  `json:"status"`
	Port      *int    `json:"port,omitempty"`       // Only set when running
	StartedAt *string `json:"started_at,omitempty"` // Only set when running
	LocalURL  *string `json:"local_url,omitempty"`  // Only set when running
	RemoteURL *string `json:"remote_url,omitempty"` // Only set when running
	// Version is the running version from server.json, only set when running.
	// Absent on a running node means one started by a build that predates the
	// field — and restarts.
	Version *string `json:"version,omitempty"`
	// RestartRequestedAt is when this cluster accepted a restart of the node
	// (RFC3339), set while it is restarting and while RestartError is.
	RestartRequestedAt *string `json:"restart_requested_at,omitempty"`
	// RestartError is why the last restart did not come back within
	// restartTimeout, in English, to be shown as it is.
	RestartError *string `json:"restart_error,omitempty"`
}
