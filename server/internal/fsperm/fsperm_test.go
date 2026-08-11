package fsperm

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/internal/fspermtest"
)

func TestRestrictDir(t *testing.T) {
	tests := []struct {
		name    string
		prepare func(t *testing.T, dir string)
	}{
		{
			name:    "creates a missing directory and its parents",
			prepare: func(*testing.T, string) {},
		},
		{
			// The data directory of an installation that predates RestrictDir
			// already exists, created 0755 and inheriting its parent's ACEs.
			name: "tightens a directory that already exists",
			prepare: func(t *testing.T, dir string) {
				if err := os.MkdirAll(dir, 0755); err != nil {
					t.Fatalf("MkdirAll: %v", err)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "parent", ".pockode")
			tt.prepare(t, dir)

			if err := RestrictDir(dir); err != nil {
				t.Fatalf("RestrictDir() error = %v", err)
			}
			fspermtest.RequireOwnerOnly(t, dir)
			requireInheritanceBroken(t, dir)
		})
	}
}

// The directory is restricted once, before anything writes into it, so what has
// to hold is that files appearing later are covered too — including the ones
// filestore produces by writing a temp file and renaming it over the target.
func TestRestrictDir_ProtectsFilesWrittenAfterwards(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".pockode")
	if err := RestrictDir(dir); err != nil {
		t.Fatalf("RestrictDir() error = %v", err)
	}

	created := filepath.Join(dir, "created.json")
	if err := os.WriteFile(created, []byte("{}"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	tmp := filepath.Join(dir, "renamed.json.tmp")
	if err := os.WriteFile(tmp, []byte("{}"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	renamed := filepath.Join(dir, "renamed.json")
	if err := os.Rename(tmp, renamed); err != nil {
		t.Fatalf("Rename: %v", err)
	}

	requireContentsProtected(t, dir, created)
	requireContentsProtected(t, dir, renamed)
}

// An installation that predates this package has a data directory full of
// files already. On unix the directory's mode covers them; on Windows the
// system propagates the new inheritable ACEs down to existing children, which
// is documented behaviour of SetNamedSecurityInfo rather than something the
// code does, so it is worth pinning down here.
func TestRestrictDir_ProtectsFilesThatAlreadyExisted(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".pockode")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	existing := filepath.Join(dir, "relay.json")
	if err := os.WriteFile(existing, []byte("{}"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if err := RestrictDir(dir); err != nil {
		t.Fatalf("RestrictDir() error = %v", err)
	}

	requireContentsProtected(t, dir, existing)
}

// Everything above rests on fspermtest.OwnerOnly actually rejecting something.
// A check that never fires would make each of those tests green for no reason —
// and on Windows, where the assertion reads a DACL rather than a mode word,
// that would go unnoticed.
func TestOwnerOnlyRejectsAPathOthersCanReach(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".pockode")
	if err := RestrictDir(dir); err != nil {
		t.Fatalf("RestrictDir() error = %v", err)
	}
	if err := fspermtest.OwnerOnly(dir); err != nil {
		t.Fatalf("OwnerOnly() rejected a restricted directory: %v", err)
	}

	makeReachableByOthers(t, dir)

	if err := fspermtest.OwnerOnly(dir); err == nil {
		t.Error("OwnerOnly() accepted a directory other local users can reach")
	}
}

// git's `store` helper rewrites .git-credentials through a lock file it renames
// over the target, so the restriction has to hold for a file replaced that way
// by a process that knows nothing about it.
func TestRestrictDir_SurvivesAReplacementWrittenElsewhere(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".git")
	if err := RestrictDir(dir); err != nil {
		t.Fatalf("RestrictDir() error = %v", err)
	}

	credentials := filepath.Join(dir, ".git-credentials")
	if err := os.WriteFile(credentials, []byte("https://x:old@example.com\n"), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	lock := credentials + ".lock"
	if err := os.WriteFile(lock, []byte("https://x:new@example.com\n"), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Rename(lock, credentials); err != nil {
		t.Fatalf("Rename: %v", err)
	}

	requireContentsProtected(t, dir, credentials)
}
