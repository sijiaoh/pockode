//go:build !windows

package fspermtest

import (
	"fmt"
	"os"
)

// OwnerOnly returns nil if path denies group and other entirely, and an error
// describing what it grants otherwise.
func OwnerOnly(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat %s: %w", path, err)
	}
	if perm := info.Mode().Perm(); perm&0077 != 0 {
		return fmt.Errorf("%s has mode %#o, want no group or other bits", path, perm)
	}
	return nil
}
