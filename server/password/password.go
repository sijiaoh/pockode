// Package password defines how the Pockode server obtains the password that
// guards its API.
//
// The credential is a user-chosen shared secret that the user types on their
// phone, so it is a password rather than a token — the old name invited the
// assumptions that go with a high-entropy random string (no expiry needed, safe
// to keep in localStorage forever), which is exactly what it must not get. The
// old flag and environment variable are still accepted for one deprecation
// period; see Resolve.
package password

import (
	"fmt"
	"os"
)

// EnvVar is the environment variable the server reads its password from when
// the --password flag is not provided.
//
// Passing the password via the environment instead of a command-line flag keeps
// it out of the process argv, which on Linux is world-readable through
// /proc/<pid>/cmdline and `ps`. Cluster mode uses this to hand spawned node
// servers their password without leaking it to other local users.
const EnvVar = "POCKODE_PASSWORD"

// LegacyEnvVar is the pre-rename name of EnvVar, still read so that an existing
// launcher script keeps working across the rename.
const LegacyEnvVar = "POCKODE_AUTH_TOKEN"

// RemovalVersion is when the deprecated --auth-token flag and LegacyEnvVar stop
// being read. The deprecation period is three minor releases (the rename landed
// in v0.17.0), long enough for a pinned launcher script to be noticed and
// updated.
const RemovalVersion = "v0.20.0"

// Credential is a resolved password together with what the caller must tell the
// user about how it arrived.
type Credential struct {
	// Password is "" when no source supplied one; the caller decides how to
	// refuse, because a server and a cluster report startup failures
	// differently.
	Password string
	// DeprecationWarning is the message to log once at startup, non-empty only
	// when a deprecated source was set — including when it merely repeated the
	// new one, since the user still has a name to update.
	DeprecationWarning string
}

// Resolve returns the password, preferring, in order: the --password flag, the
// deprecated --auth-token flag, EnvVar, LegacyEnvVar.
//
// Giving both names of a pair different values is refused rather than resolved
// by precedence: the two spellings then disagree about what the password is,
// and silently picking one would leave whoever typed the other locked out with
// no explanation.
func Resolve(flagValue, legacyFlagValue string) (Credential, error) {
	envValue := os.Getenv(EnvVar)
	legacyEnvValue := os.Getenv(LegacyEnvVar)

	if flagValue != "" && legacyFlagValue != "" && flagValue != legacyFlagValue {
		return Credential{}, fmt.Errorf("--password and --auth-token are both set with different values; remove --auth-token")
	}
	if envValue != "" && legacyEnvValue != "" && envValue != legacyEnvValue {
		return Credential{}, fmt.Errorf("%s and %s are both set with different values; unset %s", EnvVar, LegacyEnvVar, LegacyEnvVar)
	}

	cred := Credential{}
	switch {
	case flagValue != "":
		cred.Password = flagValue
	case legacyFlagValue != "":
		cred.Password = legacyFlagValue
	case envValue != "":
		cred.Password = envValue
	default:
		cred.Password = legacyEnvValue
	}

	switch {
	case legacyFlagValue != "":
		cred.DeprecationWarning = "--auth-token is deprecated, use --password (env " + EnvVar + "); it will be removed in " + RemovalVersion
	case legacyEnvValue != "":
		cred.DeprecationWarning = LegacyEnvVar + " is deprecated, use " + EnvVar + "; it will be removed in " + RemovalVersion
	}

	return cred, nil
}

// Load resolves the password (see Resolve) and then removes both EnvVar and
// LegacyEnvVar from the process environment so neither is inherited by child
// processes the server spawns (AI CLIs, git, worktree setup hooks). Leaving the
// password in the environment would expose it to AI-generated — and potentially
// prompt-injected — code, which could exfiltrate it for persistent remote
// access via the relay.
//
// The unset is unconditional and covers both names: even when the password came
// from a flag, a stale variable under either spelling must not reach children.
// Call once at startup, after flag parsing and before spawning anything.
func Load(flagValue, legacyFlagValue string) (Credential, error) {
	cred, err := Resolve(flagValue, legacyFlagValue)
	os.Unsetenv(EnvVar)
	os.Unsetenv(LegacyEnvVar)
	return cred, err
}
