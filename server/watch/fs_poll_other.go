//go:build !(darwin || dragonfly || freebsd || netbsd || openbsd)

package watch

// pollDirs is unset where the kernel reports a directory's entries itself
// (inotify, ReadDirectoryChangesW): what an entry points at cannot stop the
// directory's events there. See fs_poll_kqueue.go.
const pollDirs = false
