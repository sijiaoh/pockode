// Package serverinfo handles the server.json runtime file.
// This file contains server metadata (PID, port, start time) for orchestration programs.
package serverinfo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

const filename = "server.json"

// Info represents the server runtime information.
type Info struct {
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	StartedAt string `json:"started_at"`
}

// Write creates the server.json file in the given data directory.
// Creates the data directory if it doesn't exist.
func Write(dataDir string, port int) error {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return err
	}

	info := Info{
		PID:       os.Getpid(),
		Port:      port,
		StartedAt: time.Now().UTC().Format(time.RFC3339),
	}

	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(dataDir, filename), data, 0644)
}

// Delete removes the server.json file from the given data directory.
// Returns nil if the file doesn't exist.
func Delete(dataDir string) error {
	err := os.Remove(filepath.Join(dataDir, filename))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
