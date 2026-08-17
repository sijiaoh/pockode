package relay

import (
	"path/filepath"
	"testing"

	"github.com/pockode/server/internal/fspermtest"
)

func TestStore_LoadSave(t *testing.T) {
	tests := []struct {
		name    string
		cfg     *StoredConfig
		wantErr bool
	}{
		{
			name: "valid config",
			cfg: &StoredConfig{
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayToken:  "test_token_abc123",
				RelayServer: "cloud.pockode.com",
			},
			wantErr: false,
		},
		{
			name: "minimal config",
			cfg: &StoredConfig{
				Subdomain:   "minimal",
				RelayServer: "localhost",
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			store := NewStore(dir)

			err := store.Save(tt.cfg)
			if (err != nil) != tt.wantErr {
				t.Errorf("Save() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if tt.wantErr {
				return
			}

			loaded, err := store.Load()
			if err != nil {
				t.Errorf("Load() error = %v", err)
				return
			}

			if loaded.Subdomain != tt.cfg.Subdomain {
				t.Errorf("Subdomain = %v, want %v", loaded.Subdomain, tt.cfg.Subdomain)
			}
			if loaded.RelayToken != tt.cfg.RelayToken {
				t.Errorf("RelayToken = %v, want %v", loaded.RelayToken, tt.cfg.RelayToken)
			}
			if loaded.RelayServer != tt.cfg.RelayServer {
				t.Errorf("RelayServer = %v, want %v", loaded.RelayServer, tt.cfg.RelayServer)
			}
		})
	}
}

func TestStore_LoadNonExistent(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	cfg, err := store.Load()
	if err != nil {
		t.Errorf("Load() error = %v, want nil", err)
	}
	if cfg != nil {
		t.Errorf("Load() = %v, want nil for non-existent file", cfg)
	}
}

// The relay token is the one credential here that outlives the process, so what
// has to hold is that Save leaves neither the file nor the directory it sits in
// reachable by another local user. Both halves matter: on Windows the file is
// protected only through the directory it inherits from.
func TestStore_SaveRestrictsTokenFile(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	cfg := &StoredConfig{
		Subdomain:   "test",
		RelayToken:  "secret_token",
		RelayServer: "localhost",
	}

	if err := store.Save(cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	fspermtest.RequireOwnerOnly(t, dir)
	fspermtest.RequireOwnerOnly(t, filepath.Join(dir, "relay.json"))
}
