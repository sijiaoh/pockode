package filetransfer

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// resolvedName is the path beneath root that f, opened there as name, has in
// the file system. On Windows a name can be another spelling of a different
// one: an 8.3 short name such as ENV~1 opens .env, and GIT~1 is .git. So what
// is checked is the long name the file system resolved, never the one asked.
func resolvedName(root *os.Root, name string, f *os.File) (string, error) {
	dir, err := root.Open(".")
	if err != nil {
		return "", err
	}
	defer dir.Close()

	base, err := finalPath(dir)
	if err != nil {
		return "", err
	}
	target, err := finalPath(f)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, target)
	if err != nil || !filepath.IsLocal(rel) {
		return "", fmt.Errorf("%s resolves to %s, which is not beneath %s", name, target, base)
	}
	return rel, nil
}

// From fileapi.h: the normalized name, long names in place of short ones, on
// the NT device path, which every volume has where a drive letter or a GUID
// path may be missing.
const (
	fileNameNormalized = 0x0
	volumeNameNT       = 0x2
)

func finalPath(f *os.File) (string, error) {
	conn, err := f.SyscallConn()
	if err != nil {
		return "", err
	}
	var path string
	var pathErr error
	err = conn.Control(func(fd uintptr) {
		buf := make([]uint16, windows.MAX_PATH)
		for {
			n, err := windows.GetFinalPathNameByHandle(windows.Handle(fd), &buf[0], uint32(len(buf)), fileNameNormalized|volumeNameNT)
			if err != nil {
				pathErr = err
				return
			}
			// Too small a buffer is answered with the size it needs.
			if n < uint32(len(buf)) {
				path = windows.UTF16ToString(buf[:n])
				return
			}
			buf = make([]uint16, n)
		}
	})
	if err != nil {
		return "", err
	}
	return path, pathErr
}
