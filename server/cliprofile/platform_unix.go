//go:build !windows

package cliprofile

import "fmt"

// codexPlatformPrivate is empty: Codex's SQLite databases are shared. SQLite's
// unix layer resolves a symlinked database to the real file and keeps its
// -wal and -shm beside that, so every profile meets in one write-ahead log.
var codexPlatformPrivate []string

func symlinkRefusedReason(dir string, err error) string {
	return fmt.Sprintf("Additional accounts need symbolic links, and the file system refused one in %s: %v", dir, err)
}
