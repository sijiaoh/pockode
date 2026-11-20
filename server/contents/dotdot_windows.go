package contents

import "path/filepath"

// asFollowed is a link target as the OS walks it. Windows applies ".." to the
// text, before any link in it is followed: CreateSymbolicLinkW stores an
// absolute target as the NT path Win32 normalization makes of it, ".."
// already gone (os.Readlink reads back C:\w\secret for C:\w\l\..\secret), and
// the I/O manager joins a relative target to the link's directory and
// normalizes the result the same way. So "l\..\secret" is the work
// directory's secret even where l links out, and that is where the link is
// followed — it never names what l leads to.
//
// Cleaning keeps a leading "..", which the walk still applies to the link's
// real directory, as Windows applies it to the path it reparsed.
func asFollowed(target string) string {
	return filepath.Clean(target)
}
