package cloudcred

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/internal/fspermtest"
)

// The token is handed out only to the cloud that issued it, and logging out
// leaves a machine that has none to hand out.
func TestStoreMachineToken(t *testing.T) {
	store := NewStore(t.TempDir())
	if err := store.Save(&Credential{CloudURL: "https://cloud.pockode.com", MachineToken: "token"}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	for _, tt := range []struct {
		cloudURL string
		want     string
	}{
		{"https://cloud.pockode.com", "token"},
		{"https://local.pockode.com", ""},
	} {
		got, err := store.MachineToken(tt.cloudURL)
		if err != nil {
			t.Fatalf("MachineToken(%q): %v", tt.cloudURL, err)
		}
		if got != tt.want {
			t.Errorf("MachineToken(%q) = %q, want %q", tt.cloudURL, got, tt.want)
		}
	}

	if err := store.Delete(); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, err := store.MachineToken("https://cloud.pockode.com"); err != nil || got != "" {
		t.Errorf("MachineToken after Delete = %q, %v; want no token", got, err)
	}
	if err := store.Delete(); err != nil {
		t.Errorf("Delete without a file: %v", err)
	}
}

func TestStoreSaveRestrictsDirectory(t *testing.T) {
	configDir := t.TempDir()
	if err := NewStore(configDir).Save(&Credential{CloudURL: "https://cloud.pockode.com", MachineToken: "token"}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	fspermtest.RequireOwnerOnly(t, filepath.Join(configDir, "pockode"))
}

// Polling for a login must not create the directory it is waiting for.
func TestStoreLoadWithoutDirectory(t *testing.T) {
	configDir := t.TempDir()
	cred, err := NewStore(configDir).Load()
	if err != nil || cred != nil {
		t.Fatalf("Load = %+v, %v; want nil, nil", cred, err)
	}
	if _, err := os.Stat(filepath.Join(configDir, "pockode")); !os.IsNotExist(err) {
		t.Errorf("Load created the directory (stat error %v)", err)
	}
}
