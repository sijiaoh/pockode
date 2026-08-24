package relay

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/pockode/server/filestore"
)

type StoredConfig struct {
	Subdomain   string `json:"subdomain"`
	RelayToken  string `json:"relay_token"`
	RelayServer string `json:"relay_server"`
}

type Store struct {
	path string
}

func NewStore(dataDir string) *Store {
	return &Store{
		path: filepath.Join(dataDir, "relay.json"),
	}
}

// Load returns nil if the file does not exist, or if it was damaged by an
// interrupted write and had to be quarantined — the caller then re-registers,
// which is the same recovery path as an invalid token.
func (s *Store) Load() (*StoredConfig, error) {
	var cfg StoredConfig
	found, err := filestore.ReadJSONOrQuarantine(s.path, "relay config", &cfg)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}

	return &cfg, nil
}

// Save uses 0600 permissions to protect the token.
func (s *Store) Save(cfg *StoredConfig) error {
	data, err := filestore.MarshalIndex(cfg)
	if err != nil {
		return err
	}

	return filestore.WriteFileAtomic(s.path, data, 0600)
}

func (s *Store) Delete() error {
	err := os.Remove(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
