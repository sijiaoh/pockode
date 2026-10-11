// Package serverinfo handles the server.json runtime file.
// This file contains server metadata (PID, port, start time) for orchestration programs.
package serverinfo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/pockode/server/filestore"
	"github.com/pockode/server/internal/fsperm"
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
	// outlives the process and is not the user-facing --password.
	Token string `json:"token,omitempty"`
}

// Write creates the server.json file in the given data directory.
// Creates the data directory if it doesn't exist.
func Write(dataDir string, port int, localURL, remoteURL, token string) error {
	return write(dataDir, newInfo(port, localURL, remoteURL, token))
}

func newInfo(port int, localURL, remoteURL, token string) Info {
	return Info{
		PID:       os.Getpid(),
		Port:      port,
		StartedAt: time.Now().UTC().Format(time.RFC3339),
		LocalURL:  localURL,
		RemoteURL: remoteURL,
		Token:     token,
	}
}

func write(dataDir string, info Info) error {
	if err := fsperm.RestrictDir(dataDir); err != nil {
		return err
	}

	data, err := filestore.MarshalIndex(info)
	if err != nil {
		return err
	}

	// Written atomically: a truncated server.json leaves every MCP subprocess
	// unable to reach the local API, and unlike most state it is not re-read
	// from a source of truth — this write is the source of truth.
	// 0600 because it holds the local API token (a credential). WriteFileAtomic
	// always applies the mode, including over a stale file left by a crash. The
	// mode only covers unix; on Windows the protection comes from the restricted
	// data directory above, which the file inherits.
	return filestore.WriteFileAtomic(filepath.Join(dataDir, filename), data, 0600)
}

// Publisher keeps server.json in step with a server whose remote URL can
// change while it runs: renewing the relay credentials can move it to a new
// subdomain.
//
// The remote URL is read from its source on every write rather than handed in,
// so that a change racing the first Publish can only ever leave the newer URL
// on disk.
type Publisher struct {
	dataDir   string
	remoteURL func() string

	infoMu    sync.Mutex // serializes writes, so the last one carries the latest URL
	info      Info
	published bool
}

func NewPublisher(dataDir string, port int, localURL, token string, remoteURL func() string) *Publisher {
	return &Publisher{
		dataDir:   dataDir,
		remoteURL: remoteURL,
		info:      newInfo(port, localURL, "", token),
	}
}

// Publish writes server.json for the first time. A cluster may act on the
// file the moment it appears, so the server calls this only once it is ready
// to be found.
func (p *Publisher) Publish() error {
	p.infoMu.Lock()
	defer p.infoMu.Unlock()
	if err := p.writeLocked(); err != nil {
		return err
	}
	p.published = true
	return nil
}

// Refresh rewrites server.json with the current remote URL. Before Publish it
// does nothing: Publish will read the URL itself.
func (p *Publisher) Refresh() error {
	p.infoMu.Lock()
	defer p.infoMu.Unlock()
	if !p.published {
		return nil
	}
	return p.writeLocked()
}

func (p *Publisher) writeLocked() error {
	p.info.RemoteURL = p.remoteURL()
	return write(p.dataDir, p.info)
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
