package relay

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/pockode/server/internal/fsperm"
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

// Save restricts the data directory to the owner before writing, because that
// is what protects the relay token: the 0600 below is inert on Windows, where a
// file simply inherits its directory's ACL. See internal/fsperm.
//
// Stealing this token is worth doing — it lets the holder register the user's
// subdomain on the relay and receive the requests their phone makes, auth
// header included.
func (s *Store) Save(cfg *StoredConfig) error {
	if err := fsperm.RestrictDir(filepath.Dir(s.path)); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(s.path, data, 0600)
}

func (s *Store) Delete() error {
	err := os.Remove(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
