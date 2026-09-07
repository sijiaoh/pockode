// Package authtoken defines how the Pockode server obtains its API auth token.
package authtoken

import "os"

// EnvVar is the environment variable the server reads its auth token from when
// the --auth-token flag is not provided.
//
// Passing the token via the environment instead of a command-line flag keeps it
// out of the process argv, which on Linux is world-readable through
// /proc/<pid>/cmdline and `ps`. Cluster mode uses this to hand spawned node
// servers their token without leaking it to other local users.
const EnvVar = "POCKODE_AUTH_TOKEN"

// Resolve returns the auth token, preferring the explicit flag value and
// falling back to EnvVar. Returns "" if neither is set.
func Resolve(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	return os.Getenv(EnvVar)
}

// Load resolves the auth token (see Resolve) and then removes EnvVar from the
// process environment so it is not inherited by child processes the server
// spawns (AI CLIs, git, worktree setup hooks). Leaving the token in the
// environment would expose it to AI-generated — and potentially prompt-injected
// — code, which could exfiltrate it for persistent remote access via the relay.
//
// The unset is unconditional: even when the token came from the flag, a stale
// EnvVar must not reach children. Call once at startup, after flag parsing and
// before spawning anything.
func Load(flagValue string) string {
	token := Resolve(flagValue)
	os.Unsetenv(EnvVar)
	return token
}
