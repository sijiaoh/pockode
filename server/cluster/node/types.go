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
)

// NodeStatus contains the status information of a node.
type NodeStatus struct {
	ID        string  `json:"id"`
	Status    Status  `json:"status"`
	Port      *int    `json:"port,omitempty"`       // Only set when running
	StartedAt *string `json:"started_at,omitempty"` // Only set when running
}
