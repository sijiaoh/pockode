//go:build !windows

package worktree

// lookupHookShell returns the interpreter used to run the setup hook.
//
// bash is resolved through PATH like any other command on POSIX systems. When
// it is missing, exec reports it when the hook runs, and the hook failure path
// already surfaces that to the caller — so there is nothing to probe for here.
func lookupHookShell() (string, error) {
	return "bash", nil
}
