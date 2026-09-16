package codex

import (
	"path/filepath"
	"strings"
)

// uriPathToNative converts the path component of a file URI to a native path.
//
// A Windows file URI writes the drive letter as another path segment —
// file:///C:/tmp/shot.png — so in front of a drive the leading slash belongs to
// the URI's grammar and not to the path. In front of anything else it is the
// path's own: file:///tmp/shot.png names \tmp\shot.png, rooted on the current
// volume, and trimming that slash would hand imageViewLocalPath a relative path
// for it to join onto the work directory — a different file, and no complaint
// from anything about it.
func uriPathToNative(path string) string {
	if rest := strings.TrimPrefix(path, "/"); filepath.VolumeName(rest) != "" {
		path = rest
	}
	return filepath.FromSlash(path)
}
