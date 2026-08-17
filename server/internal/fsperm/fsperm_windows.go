//go:build windows

package fsperm

import (
	"fmt"
	"os"
	"runtime"

	"golang.org/x/sys/windows"
)

// RestrictDir creates dir along with any missing parents and replaces its ACL
// with one naming only the current user, SYSTEM and Administrators.
//
// The mode handed to MkdirAll is inert on Windows, so the ACL is the whole of
// the protection. Files created in dir afterwards inherit it, which is what
// lets a single call cover every credential the directory ends up holding.
//
// The returned error covers only creating dir. An ACL the filesystem will not
// accept — FAT and exFAT have none — is reported through warnUnrestricted
// instead.
func RestrictDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	restrict(dir)
	return nil
}

func restrict(path string) {
	dacl, err := ownerOnlyDACL()
	if err != nil {
		warnUnrestricted(path, fmt.Errorf("build ACL: %w", err))
		return
	}

	// PROTECTED_DACL_SECURITY_INFORMATION discards the ACEs inherited from the
	// parent. Without it the entry that leaks in the first place — the
	// BUILTIN\Users read ACE every directory below a drive root inherits —
	// would simply sit alongside the ones granted here, and the whole call
	// would buy nothing.
	err = windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil,
	)
	if err != nil {
		warnUnrestricted(path, err)
	}
}

// ownerOnlyDACL grants full access to the current user, SYSTEM and the
// Administrators group, and to nobody else.
//
// SYSTEM and Administrators are deliberate. An administrator can take ownership
// of any object and read it regardless, so leaving them out would not keep a
// secret from anyone — it would only break backup, antivirus and
// run-as-a-service setups while leaving the exposure this package exists to
// close, ordinary co-tenant accounts that are in BUILTIN\Users but not in
// Administrators, exactly where it was. It is also the principal set
// Win32-OpenSSH accepts on a private key.
func ownerOnlyDACL() (*windows.ACL, error) {
	// A pseudo-handle for the current process; it must not be closed.
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("look up current user: %w", err)
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return nil, fmt.Errorf("look up SYSTEM sid: %w", err)
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return nil, fmt.Errorf("look up Administrators sid: %w", err)
	}

	sids := []*windows.SID{user.User.Sid, system, admins}
	entries := make([]windows.EXPLICIT_ACCESS, 0, len(sids))
	for _, sid := range sids {
		entries = append(entries, windows.EXPLICIT_ACCESS{
			AccessPermissions: windows.GENERIC_ALL,
			AccessMode:        windows.GRANT_ACCESS,
			Inheritance:       windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeType:  windows.TRUSTEE_IS_UNKNOWN,
				TrusteeValue: windows.TrusteeValueFromSID(sid),
			},
		})
	}

	acl, err := windows.ACLFromEntries(entries, nil)
	// Every one of these sids lives in a Go-allocated buffer, and the TRUSTEE
	// above holds it as a uintptr the garbage collector cannot see through.
	// Nothing else references them past the loop, so without this the buffers
	// are collectable while ACLFromEntries is still reading them. Keeping the
	// slice alive covers all three, including the buffer behind user.User.Sid.
	runtime.KeepAlive(sids)
	if err != nil {
		return nil, fmt.Errorf("assemble ACL: %w", err)
	}
	return acl, nil
}
