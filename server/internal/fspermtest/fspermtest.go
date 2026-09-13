// Package fspermtest asserts that a path is reachable only by its owner.
//
// It lives apart from fsperm because the check reads platform state that has no
// common shape — a mode word on unix, a DACL on Windows — and more than one
// package needs to make the assertion: fsperm proves the mechanism, while the
// packages writing credentials prove they actually invoke it.
//
// Keeping it here is what lets those assertions run on Windows instead of being
// skipped there, which is the point: a permission test that skips on the one
// platform whose permissions are in question proves nothing.
//
// OwnerOnly returns the reason rather than failing, so that a test can check
// the check — see fsperm's negative control. An assertion nothing exercises in
// the failing direction can be vacuously true, and on Windows that would make
// every test resting on it green for no reason.
package fspermtest

import "testing"

// RequireOwnerOnly fails the test unless path is reachable only by its owner.
func RequireOwnerOnly(t testing.TB, path string) {
	t.Helper()

	if err := OwnerOnly(path); err != nil {
		t.Error(err)
	}
}
