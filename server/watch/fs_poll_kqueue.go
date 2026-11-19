//go:build darwin || dragonfly || freebsd || netbsd || openbsd

package watch

// pollDirs is set where fsnotify sits on kqueue, which has no event for a
// directory's entries: fsnotify re-reads the directory on every write to it
// and stops at the first entry it cannot open, so with a broken link in a
// directory, every name created after it in sort order goes unreported (as of
// fsnotify v1.10.1). Polling each watched directory's modification time
// alongside covers that without depending on what its entries point at.
const pollDirs = true
