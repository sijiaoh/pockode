package globalconfig

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

const relayFileName = "relay.json"

// RelayCredentials holds the unified relay credentials shared across all workspaces.
type RelayCredentials struct {
	// Subdomain is the assigned relay subdomain.
	Subdomain string `json:"subdomain,omitempty"`

	// RelayToken is the authentication token for the relay service.
	RelayToken string `json:"relay_token,omitempty"`

	// RelayServer is the relay server URL.
	RelayServer string `json:"relay_server,omitempty"`
}

// IsValid returns true if all required fields are set.
func (r *RelayCredentials) IsValid() bool {
	return r.Subdomain != "" && r.RelayToken != "" && r.RelayServer != ""
}

// RelayStore manages the global relay.json file.
type RelayStore struct {
	path string
	mu   sync.RWMutex
}

// NewRelayStore creates a RelayStore for the global relay credentials.
func NewRelayStore() (*RelayStore, error) {
	dir, err := Dir()
	if err != nil {
		return nil, fmt.Errorf("get global config dir: %w", err)
	}

	return &RelayStore{
		path: filepath.Join(dir, relayFileName),
	}, nil
}

// Load returns the stored credentials, or nil if not configured.
func (s *RelayStore) Load() (*RelayCredentials, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read relay credentials: %w", err)
	}

	var creds RelayCredentials
	if err := json.Unmarshal(data, &creds); err != nil {
		slog.Warn("globalconfig: corrupted relay.json, treating as empty", "error", err)
		return nil, nil
	}

	return &creds, nil
}

// Save stores the credentials with 0600 permissions to protect the token.
func (s *RelayStore) Save(creds *RelayCredentials) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal relay credentials: %w", err)
	}

	// Use 0600 to protect relay_token, atomic write to prevent corruption
	if err := writeFileAtomic(s.path, data, 0600); err != nil {
		return fmt.Errorf("write relay credentials: %w", err)
	}

	return nil
}

// Delete removes the stored credentials.
func (s *RelayStore) Delete() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	err := os.Remove(s.path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
