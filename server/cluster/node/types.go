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
