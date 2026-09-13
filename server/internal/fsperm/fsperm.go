// Package fsperm confines the directories and files Pockode keeps credentials
// in to the user running the server.
//
// The unit of protection is the directory, not the file, for two reasons:
//
//   - Windows has no POSIX mode bits. Go maps the perm argument of os.WriteFile
//     to the read-only attribute and to nothing else, and 0600 has the write bit
//     set, so it does not even do that — the file gets whatever its parent
//     directory's ACL grants, and every directory created below a drive root
//     inherits an ACE granting BUILTIN\Users read access. Restricting a
//     directory once makes every file created inside it
//     inherit that restriction, where restricting files would have to be
//     repeated at every write site and would still miss the ones written by
//     other programs (git's `store` credential helper, for one).
//   - Both filestore and that helper rewrite a file by creating a temp file
//     next to it and renaming over the target. The replacement carries the
//     mode and ACL it was created with, so a per-file restriction is undone,
//     silently, by the next write. A restricted directory survives it, because
//     the temp file is created inside the directory and inherits from it.
//
// The second reason is not hypothetical: git's `store` helper rewrites
// .git-credentials on every successful authentication, and its umask(077) keeps
// that at 0600 on unix but means nothing on Windows. Restricting the containing
// directory is what holds there.
package fsperm

import "log/slog"

// warnUnrestricted reports a restriction the filesystem would not accept.
//
// This is a warning rather than an error on purpose. Some filesystems have no
// permissions to set at all — FAT and exFAT on a removable drive, a few network
// mounts — and keeping a project on one is a legitimate thing to do. Before
// this package the server started there regardless, so failing now would turn a
// hardening measure into a new way for Pockode to refuse to run, over a
// defence-in-depth layer rather than the control that actually guards the
// server (the auth token). What the caller must not do is proceed quietly, so
// the path and the underlying error are named here.
func warnUnrestricted(path string, err error) {
	slog.Warn("could not restrict path to the current user, other local users may be able to read it",
		"path", path, "error", err)
}
