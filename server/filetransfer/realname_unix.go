//go:build !windows

package filetransfer

import "os"

// resolvedName is the path beneath root that f, opened there as name, has in
// the file system. On darwin and linux it is name: a case- or
// normalization-insensitive file system may spell a name another way, but
// never with a leading dot added or dropped, which is all this is asked for.
// What a link inside root leads to is the link's business, as for any other
// request.
func resolvedName(root *os.Root, name string, f *os.File) (string, error) {
	return name, nil
}
