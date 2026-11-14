package cliprofile

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

// codexPlatformPrivate keeps every Codex SQLite database private. SQLite's
// Windows layer does not resolve symlinks: it puts the -wal and -shm beside the
// link, so a profile opening a shared database through one would write a
// second write-ahead log next to the default profile's, and the database is
// corrupted. Codex rebuilds its thread state from the shared sessions/, so a
// resumed conversation still works; what is not shared is the rest of that
// state.
var codexPlatformPrivate = []string{"*.sqlite*"}

func symlinkRefusedReason(dir string, err error) string {
	if errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) {
		return "Additional accounts need symbolic links, which Windows lets programs create only with Developer Mode on. Turn it on in Settings > System > For developers, then restart Pockode."
	}
	return fmt.Sprintf("Additional accounts need symbolic links, and Windows refused one in %s: %v", dir, err)
}
