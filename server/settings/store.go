package settings

import (
	"encoding/json"
	"log/slog"
	"path/filepath"
	"sync"

	"github.com/pockode/server/filestore"
)

// OnChangeListener is notified when settings are updated.
type OnChangeListener interface {
	OnSettingsChange(settings Settings)
}

type Store struct {
	file     *filestore.File
	dataMu   sync.RWMutex
	data     Settings
	listener OnChangeListener
}

// NewStore loads existing settings from disk or uses defaults.
func NewStore(dataDir string) (*Store, error) {
	s := &Store{
		data: Default(),
	}

	f, err := filestore.New(filestore.Config{
		Path:     filepath.Join(dataDir, "settings.json"),
		Label:    "settings",
		OnReload: s.reloadFromDisk,
	})
	if err != nil {
		return nil, err
	}
	s.file = f

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
	data, err := filestore.MarshalIndex(settings)
	if err != nil {
		return err
	}

	s.dataMu.Lock()

	if err := s.file.Write(data); err != nil {
		s.dataMu.Unlock()
		return err
	}

	s.data = settings
	listener := s.listener
	s.dataMu.Unlock()

	if listener != nil {
		listener.OnSettingsChange(settings)
	}

	return nil
}

func (s *Store) SetOnChangeListener(listener OnChangeListener) {
	s.dataMu.Lock()
	defer s.dataMu.Unlock()
	s.listener = listener
}

func (s *Store) StartWatching() error {
	return s.file.StartWatching()
}

func (s *Store) StopWatching() {
	s.file.StopWatching()
}

func (s *Store) load() error {
	data, err := s.file.Read()
	if err != nil {
		return err
	}
	if data == nil {
		return nil
	}

	var settings Settings
	if err := json.Unmarshal(data, &settings); err != nil {
		// Fall back to default for corrupted JSON
		return nil
	}

	s.data = settings
	return nil
}

func (s *Store) reloadFromDisk() {
	genBefore := s.file.SnapshotGen()

	data, err := s.file.Read()
	if err != nil {
		slog.Error("settings: failed to read from disk on reload", "error", err)
		return
	}

	var settings Settings
	if data == nil {
		settings = Default()
	} else if err := json.Unmarshal(data, &settings); err != nil {
		slog.Error("settings: failed to unmarshal on reload", "error", err)
		return
	}

	s.dataMu.Lock()
	if s.file.IsStale(genBefore) {
		s.dataMu.Unlock()
		return
	}
	old := s.data
	s.data = settings
	listener := s.listener
	s.dataMu.Unlock()

	if listener != nil && old != settings {
		listener.OnSettingsChange(settings)
	}
}
