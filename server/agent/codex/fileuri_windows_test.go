package codex

import "testing"

// The leading slash before a drive letter belongs to the URI's grammar, not to
// the path — the one place a file URI is not already a native path.
func TestUriPathToNative_DriveLetter(t *testing.T) {
	if got := uriPathToNative("/C:/tmp/shot.png"); got != `C:\tmp\shot.png` {
		t.Errorf(`uriPathToNative = %q, want C:\tmp\shot.png`, got)
	}
}

// With no drive letter the slash is the path's own: dropping it would turn a
// rooted path into a relative one, which resolves somewhere else entirely.
func TestUriPathToNative_NoDriveLetter(t *testing.T) {
	if got := uriPathToNative("/tmp/shot.png"); got != `\tmp\shot.png` {
		t.Errorf(`uriPathToNative = %q, want \tmp\shot.png`, got)
	}
}
