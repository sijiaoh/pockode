//go:build !windows

package fsperm

import "os"

// RestrictDir creates dir along with any missing parents and restricts it to
// its owner. Files inside are then unreachable to other local users whatever
// mode they carry themselves, because reaching them means traversing dir and
// that needs its execute bit.
//
// The returned error covers only creating dir. A mode the filesystem will not
// accept is reported through warnUnrestricted instead.
//
// The mode is applied with an explicit Chmod rather than left to MkdirAll:
// MkdirAll leaves an already-existing directory's mode alone, and umask can
// clear bits from a freshly created one. Both matter here — the data directory
// of an installation predating this call already exists as 0755.
func RestrictDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		warnUnrestricted(dir, err)
	}
	return nil
}
