// Package serverinfo handles the server.json runtime file.
// This file contains server metadata (PID, port, start time) for orchestration programs.
package serverinfo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/pockode/server/filestore"
)

const filename = "server.json"

// Info represents the server runtime information.
type Info struct {
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	StartedAt string `json:"started_at"`
	LocalURL  string `json:"local_url,omitempty"`
	RemoteURL string `json:"remote_url,omitempty"`
	// Token authenticates local clients (e.g. the MCP subprocess) against the
	// server's local API. It is randomly generated at each startup, so it never
	// outlives the process and is not the user-facing --auth-token.
	Token string `json:"token,omitempty"`
}

// Write creates the server.json file in the given data directory.
// Creates the data directory if it doesn't exist.
func Write(dataDir string, port int, localURL, remoteURL, token string) error {
	info := Info{
		PID:       os.Getpid(),
		Port:      port,
		StartedAt: time.Now().UTC().Format(time.RFC3339),
		LocalURL:  localURL,
		RemoteURL: remoteURL,
		Token:     token,
	}

	data, err := filestore.MarshalIndex(info)
	if err != nil {
		return err
	}

	// Written atomically: a truncated server.json leaves every MCP subprocess
	// unable to reach the local API, and unlike most state it is not re-read
	// from a source of truth — this write is the source of truth.
	// 0600 because it holds the local API token (a credential). WriteFileAtomic
	// always applies the mode, including over a stale file left by a crash.
	return filestore.WriteFileAtomic(filepath.Join(dataDir, filename), data, 0600)
}

// Read reads the server.json file from the given data directory.
// Returns (nil, nil) if the file doesn't exist.
func Read(dataDir string) (*Info, error) {
	// A plain read is enough, and deliberately so: Write replaces this file by
	// rename, so a reader always sees one whole version, and taking a lock here
	// would make every reader create a lock file in a data dir it only wants to
	// inspect.
	data, err := os.ReadFile(filepath.Join(dataDir, filename))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var info Info
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, err
	}
	return &info, nil
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
