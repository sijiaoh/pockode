package globalconfig

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

const configFileName = "config.json"

// Config holds global configuration settings.
type Config struct {
	// AuthToken is the default authentication token for the server.
	AuthToken string `json:"auth_token,omitempty"`

	// DefaultPort is the preferred server port.
	DefaultPort int `json:"default_port,omitempty"`

	// CloudURL is the URL for the Pockode cloud service.
	CloudURL string `json:"cloud_url,omitempty"`
}

// DefaultConfig returns a Config with sensible defaults.
func DefaultConfig() Config {
	return Config{
		DefaultPort: 9870,
		CloudURL:    "https://cloud.pockode.com",
	}
}

// ConfigStore manages the global config.json file.
type ConfigStore struct {
	path   string
	mu     sync.RWMutex
	config Config
}

// NewConfigStore creates a ConfigStore and loads existing config from disk.
func NewConfigStore() (*ConfigStore, error) {
	dir, err := Dir()
	if err != nil {
		return nil, fmt.Errorf("get global config dir: %w", err)
	}

	s := &ConfigStore{
		path:   filepath.Join(dir, configFileName),
		config: DefaultConfig(),
	}

	if err := s.load(); err != nil {
		return nil, err
	}

	return s, nil
}

// Get returns the current config.
func (s *ConfigStore) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

// Update saves the config to disk atomically.
func (s *ConfigStore) Update(cfg Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	// Use 0600 to protect auth_token, atomic write to prevent corruption
	if err := writeFileAtomic(s.path, data, 0600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	s.config = cfg
	return nil
}

func (s *ConfigStore) load() error {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		slog.Warn("globalconfig: corrupted config.json, using defaults", "error", err)
		return nil
	}

	// Merge with defaults to ensure all fields have values
	merged := DefaultConfig()
	if cfg.AuthToken != "" {
		merged.AuthToken = cfg.AuthToken
	}
	if cfg.DefaultPort != 0 {
		merged.DefaultPort = cfg.DefaultPort
	}
	if cfg.CloudURL != "" {
		merged.CloudURL = cfg.CloudURL
	}

	s.config = merged
	return nil
}
