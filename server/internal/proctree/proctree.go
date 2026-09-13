// Package proctree terminates a subprocess together with every process it
// spawned.
//
// Killing the direct child is not killing the tree. A subprocess that runs work
// of its own has descendants — an AI CLI spawns shell commands and MCP servers,
// a network git spawns git-remote-https, ssh and credential helpers — and on
// Windows the direct child may not even be the program: npm installs `claude` as
// `claude.cmd`, so cmd.exe is the child and the real process a grandchild.
// Terminating the child alone leaves the rest behind as orphans holding pipes
// and worktree files.
//
// A Tree is set up before the process starts (New), attached once it exists
// (Adopt), and released when it has been reaped (Close).
package proctree

import "errors"

// ErrUnavailable reports that the platform mechanism could not be set up, so a
// caller that must not leave the child running has to kill the direct child
// itself. Only Windows returns it: a Unix process group needs no resource that
// could fail to be acquired.
var ErrUnavailable = errors.New("process tree termination unavailable")

// Option adjusts how a Tree is set up. Options are passed to New, because both
// platforms decide this when the child is created, not later.
type Option func(*settings)

type settings struct {
	killOnClose bool
}

// KillOnClose asks the OS to terminate whatever is still in the tree once the
// last handle to it is gone — including the handle this process holds, so a
// crash tears the tree down rather than leaving orphans behind forever.
//
// It suits a child that outlives the call which started it, such as a session's
// AI CLI. It does not suit a short command that is reaped seconds later and may
// have deliberately left something running: a network git can start a credential
// daemon meant to serve the next command too, and killing that on the way out of
// every fetch would be a change of behaviour, not a cleanup.
//
// Windows only, where a Tree owns a kernel object the rule can be attached to. A
// Unix process group belongs to no one and carries no such rule, so nothing is
// killed when a Tree is closed there, whichever options it was built with.
func KillOnClose() Option {
	return func(s *settings) { s.killOnClose = true }
}

func newSettings(opts []Option) settings {
	var s settings
	for _, opt := range opts {
		opt(&s)
	}
	return s
}
