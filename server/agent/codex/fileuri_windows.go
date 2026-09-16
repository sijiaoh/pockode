package codex

import (
	"path/filepath"
	"strings"
)

// uriPathToNative converts the path component of a file URI to a native path.
//
// A Windows file URI writes the drive letter as another path segment —
// file:///C:/tmp/shot.png — so the path component arrives with a leading slash
// that is part of the URI's grammar and not part of the path.
func uriPathToNative(path string) string {
	return filepath.FromSlash(strings.TrimPrefix(path, "/"))
}
