//go:build windows

package fsperm

import (
	"runtime"
	"testing"

	"github.com/pockode/server/internal/fspermtest"
	"golang.org/x/sys/windows"
)

// requireContentsProtected asserts that file, which lives in dir, is out of
// reach of other local users.
//
// On Windows the check has to be on file itself: a directory ACL does not deny
// access to a file below it the way a missing execute bit does on unix, so what
// protects file is the ACE set it inherited from dir. Asserting on dir instead
// would pass without proving anything.
func requireContentsProtected(t *testing.T, dir, file string) {
	t.Helper()
	fspermtest.RequireOwnerOnly(t, file)
}

// requireInheritanceBroken asserts that path carries its own DACL rather than
// its parent's.
//
// This is the only assertion that catches a lost
// PROTECTED_DACL_SECURITY_INFORMATION flag under test: the temp directory a
// test runs in sits below the user's profile, whose ACL names no open
// principal, so an unprotected DACL there would pass the open-principal check
// while leaving a real data directory below a drive root wide open.
func requireInheritanceBroken(t *testing.T, path string) {
	t.Helper()

	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("read security descriptor of %s: %v", path, err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatalf("read control bits of %s: %v", path, err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Errorf("%s still inherits ACEs from its parent; DACL = %s", path, sd.String())
	}
}

// makeReachableByOthers grants BUILTIN\Users access to dir, reproducing the ACE
// a directory below a drive root inherits by default. It is the negative
// control that keeps fspermtest.OwnerOnly honest.
//
// The DACL is applied unprotected on purpose: dir keeps the ACEs it inherited
// from the temp directory, so the test process can still clean it up, and the
// result matches the shape of the real problem — an explicit grant sitting
// alongside the owner's inherited access.
func makeReachableByOthers(t *testing.T, dir string) {
	t.Helper()

	users, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatalf("look up BUILTIN\\Users sid: %v", err)
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_UNKNOWN,
			TrusteeValue: windows.TrusteeValueFromSID(users),
		},
	}}, nil)
	runtime.KeepAlive(users)
	if err != nil {
		t.Fatalf("assemble ACL: %v", err)
	}

	err = windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
	if err != nil {
		t.Fatalf("set ACL on %s: %v", dir, err)
	}
}
