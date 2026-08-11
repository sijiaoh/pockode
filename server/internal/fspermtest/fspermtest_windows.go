//go:build windows

package fspermtest

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// openSids are the principals that stand for "any local user". BUILTIN\Users is
// the one that actually appears in practice: every directory below a drive root
// inherits a read ACE for it, so a data directory at C:\dev\app\.pockode is
// readable by every account on the machine until something removes that ACE.
var openSids = []windows.WELL_KNOWN_SID_TYPE{
	windows.WinWorldSid,
	windows.WinBuiltinUsersSid,
	windows.WinAuthenticatedUserSid,
}

// OwnerOnly returns nil if path's DACL grants nothing to any of openSids, and
// an error naming the principal it does grant to otherwise.
//
// It deliberately says nothing about where those ACEs came from, so that it
// holds both for a path restricted directly and for a file that inherited its
// ACEs from a restricted directory — the latter is not protected from
// inheritance, and must not be.
func OwnerOnly(path string) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read security descriptor of %s: %w", path, err)
	}

	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("read DACL of %s: %w", path, err)
	}
	// A nil DACL is not an empty one: it grants everyone full access.
	if dacl == nil {
		return fmt.Errorf("%s has no DACL, which grants full access to everyone", path)
	}

	for _, sidType := range openSids {
		open, err := windows.CreateWellKnownSid(sidType)
		if err != nil {
			return fmt.Errorf("look up well-known sid %d: %w", sidType, err)
		}
		granted, err := daclGrants(dacl, open)
		if err != nil {
			return fmt.Errorf("scan DACL of %s: %w", path, err)
		}
		if granted {
			return fmt.Errorf("%s grants access to %s; DACL = %s", path, open, sd.String())
		}
	}
	return nil
}

func daclGrants(dacl *windows.ACL, sid *windows.SID) (bool, error) {
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return false, fmt.Errorf("read ACE %d: %w", i, err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		// The sid is stored inline, starting at SidStart.
		if windows.EqualSid((*windows.SID)(unsafe.Pointer(&ace.SidStart)), sid) {
			return true, nil
		}
	}
	return false, nil
}
