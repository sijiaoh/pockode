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

// A save that was decided over one token never replaces another: it reports
// what it found instead. Another cloud's token and a damaged file are no token
// for this cloud.
func TestStoreSaveIfUnchanged(t *testing.T) {
	const cloudURL = "https://cloud.pockode.com"
	mine := &Credential{CloudURL: cloudURL, MachineToken: "mine"}
	for _, tt := range []struct {
		name string
		// file is cloud.json's contents beforehand; nil for none.
		file        *string
		expected    string
		wantSaved   bool
		wantCurrent string
	}{
		{"no file, expected none", nil, "", true, ""},
		{"expected token still there", ptr(`{"cloud_url":"` + cloudURL + `","machine_token":"old"}`), "old", true, "old"},
		{"another token written", ptr(`{"cloud_url":"` + cloudURL + `","machine_token":"theirs"}`), "old", false, "theirs"},
		{"token written over none", ptr(`{"cloud_url":"` + cloudURL + `","machine_token":"theirs"}`), "", false, "theirs"},
		{"another cloud's token", ptr(`{"cloud_url":"https://other.example","machine_token":"theirs"}`), "", true, ""},
		{"damaged file", ptr(`{"cloud_url":`), "", true, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := NewStore(t.TempDir())
			if tt.file != nil {
				if err := os.MkdirAll(filepath.Dir(store.path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(store.path, []byte(*tt.file), 0600); err != nil {
					t.Fatal(err)
				}
			}

			saved, current, err := store.SaveIfUnchanged(mine, tt.expected)
			if err != nil || saved != tt.wantSaved || current != tt.wantCurrent {
				t.Fatalf("SaveIfUnchanged = %v, %q, %v; want %v, %q", saved, current, err, tt.wantSaved, tt.wantCurrent)
			}
			got, err := store.MachineToken(cloudURL)
			if err != nil {
				t.Fatalf("MachineToken: %v", err)
			}
			want := tt.wantCurrent
			if tt.wantSaved {
				want = mine.MachineToken
			}
			if got != want {
				t.Errorf("stored token = %q, want %q", got, want)
			}
		})
	}
}

func ptr(s string) *string { return &s }
