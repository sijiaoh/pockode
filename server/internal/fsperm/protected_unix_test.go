//go:build !windows

package fsperm

import (
	"os"
	"testing"

	"github.com/pockode/server/internal/fspermtest"
)

// requireContentsProtected asserts that file, which lives in dir, is out of
// reach of other local users.
//
// On unix that is a property of dir alone: file keeps whatever mode its writer
// chose — 0644 for most of what filestore produces — and is unreachable anyway,
// because reaching it means traversing dir. There is no inheritance to check.
func requireContentsProtected(t *testing.T, dir, file string) {
	t.Helper()
	fspermtest.RequireOwnerOnly(t, dir)
}

// requireInheritanceBroken has nothing to assert on unix: a mode is not
// inherited from anywhere, so there is no parent state to detach from. The
// Windows counterpart checks that the DACL is protected.
func requireInheritanceBroken(t *testing.T, path string) {}

// makeReachableByOthers opens dir up again, for the negative control that keeps
// fspermtest.OwnerOnly honest.
func makeReachableByOthers(t *testing.T, dir string) {
	t.Helper()
	if err := os.Chmod(dir, 0755); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
}
