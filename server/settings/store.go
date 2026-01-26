package settings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type Store struct {
	path   string
	dataMu sync.RWMutex
	data   Settings
}

// NewStore loads existing settings from disk or uses defaults.
func NewStore(dataDir string) (*Store, error) {
	s := &Store{
		path: filepath.Join(dataDir, "settings.json"),
		data: Default(),
	}

	if err := s.load(); err != nil {
		return nil, err
	}

	return s, nil
}

func (s *Store) Get() Settings {
	s.dataMu.RLock()
	defer s.dataMu.RUnlock()
	return s.data
}

func (s *Store) Update(settings Settings) error {
	if err := settings.Validate(); err != nil {
		return err
	}

	s.dataMu.Lock()
	defer s.dataMu.Unlock()

	if err := s.save(settings); err != nil {
		return err
	}

	s.data = settings
	return nil
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}

	var settings Settings
	if err := json.Unmarshal(data, &settings); err != nil {
		// Fall back to default for corrupted JSON
		return nil
	}

	// Fall back to default for invalid values
	if err := settings.Validate(); err != nil {
		return nil
	}

	s.data = settings
	return nil
}

func (s *Store) save(settings Settings) error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}

	// Atomic write: write to temp file then rename
	tmp, err := os.CreateTemp(dir, "settings-*.json.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}

	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}

	return os.Rename(tmpPath, s.path)
}
