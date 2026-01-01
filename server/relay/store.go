package relay

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type StoredConfig struct {
	Subdomain  string `json:"subdomain"`
	FrpServer  string `json:"frp_server"`
	FrpPort    int    `json:"frp_port"`
	FrpToken   string `json:"frp_token"`
	FrpVersion string `json:"frp_version"`
}

type Store struct {
	path string
}

func NewStore(dataDir string) *Store {
	return &Store{
		path: filepath.Join(dataDir, "relay.json"),
	}
}

// Load returns nil if the file does not exist.
func (s *Store) Load() (*StoredConfig, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var cfg StoredConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// Save uses 0600 permissions to protect the token.
func (s *Store) Save(cfg *StoredConfig) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(s.path, data, 0600)
}
