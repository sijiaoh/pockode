package password

import (
	"os"
	"slices"
	"strings"
	"testing"
)

// clearEnv removes both spellings for the duration of a test; t.Setenv restores
// whatever was there afterwards.
func clearEnv(t *testing.T) {
	t.Helper()
	t.Setenv(EnvVar, "")
	t.Setenv(LegacyEnvVar, "")
	os.Unsetenv(EnvVar)
	os.Unsetenv(LegacyEnvVar)
}

func TestResolve_Precedence(t *testing.T) {
	tests := []struct {
		name          string
		flag          string
		legacyFlag    string
		env           string
		legacyEnv     string
		want          string
		wantDeprecate bool
	}{
		{name: "flag beats everything", flag: "a", legacyFlag: "a", env: "b", legacyEnv: "b", want: "a", wantDeprecate: true},
		{name: "legacy flag beats env", legacyFlag: "a", env: "b", legacyEnv: "b", want: "a", wantDeprecate: true},
		{name: "env beats legacy env", env: "b", legacyEnv: "b", want: "b", wantDeprecate: true},
		{name: "legacy env is the last resort", legacyEnv: "c", want: "c", wantDeprecate: true},
		{name: "new names alone warn about nothing", flag: "a", env: "b", want: "a"},
		{name: "nothing set", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearEnv(t)
			if tt.env != "" {
				t.Setenv(EnvVar, tt.env)
			}
			if tt.legacyEnv != "" {
				t.Setenv(LegacyEnvVar, tt.legacyEnv)
			}

			cred, err := Resolve(tt.flag, tt.legacyFlag)
			if err != nil {
				t.Fatalf("Resolve() error = %v", err)
			}
			if cred.Password != tt.want {
				t.Errorf("Password = %q, want %q", cred.Password, tt.want)
			}
			if got := cred.DeprecationWarning != ""; got != tt.wantDeprecate {
				t.Errorf("DeprecationWarning = %q, want deprecated=%v", cred.DeprecationWarning, tt.wantDeprecate)
			}
		})
	}
}

// Two spellings that disagree have no safe resolution: whoever typed the losing
// one would be locked out of a server that reports nothing wrong.
func TestResolve_ConflictingValuesAreRefused(t *testing.T) {
	t.Run("flags", func(t *testing.T) {
		clearEnv(t)
		_, err := Resolve("new", "old")
		if err == nil || !strings.Contains(err.Error(), "-auth-token") {
			t.Fatalf("Resolve() error = %v, want one naming -auth-token", err)
		}
	})

	t.Run("env vars", func(t *testing.T) {
		clearEnv(t)
		t.Setenv(EnvVar, "new")
		t.Setenv(LegacyEnvVar, "old")
		_, err := Resolve("", "")
		if err == nil || !strings.Contains(err.Error(), LegacyEnvVar) {
			t.Fatalf("Resolve() error = %v, want one naming %s", err, LegacyEnvVar)
		}
	})

	t.Run("same value is not a conflict", func(t *testing.T) {
		clearEnv(t)
		t.Setenv(EnvVar, "same")
		t.Setenv(LegacyEnvVar, "same")
		cred, err := Resolve("", "")
		if err != nil {
			t.Fatalf("Resolve() error = %v", err)
		}
		if cred.Password != "same" || cred.DeprecationWarning == "" {
			t.Errorf("got %+v, want password=same with a deprecation warning", cred)
		}
	})
}

func TestLoad_ScrubsBothEnvVars(t *testing.T) {
	// Even from a flag, and even when resolution fails: a stale value under
	// either spelling must not reach a child process.
	for _, tt := range []struct {
		name       string
		flag       string
		legacyFlag string
	}{
		{name: "password from flag", flag: "from-flag"},
		{name: "resolution failed", flag: "new", legacyFlag: "old"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			clearEnv(t)
			t.Setenv(EnvVar, "stale")
			t.Setenv(LegacyEnvVar, "stale-legacy")

			Load(tt.flag, tt.legacyFlag)

			for _, name := range []string{EnvVar, LegacyEnvVar} {
				if v, ok := os.LookupEnv(name); ok {
					t.Errorf("%s still set after Load = %q, want unset", name, v)
				}
			}
		})
	}
}

func TestLoad_ReturnsEnvPassword(t *testing.T) {
	clearEnv(t)
	t.Setenv(EnvVar, "from-env")
	cred, err := Load("", "")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cred.Password != "from-env" {
		t.Errorf("Password = %q, want from-env", cred.Password)
	}
}

func TestWithEnv_SetsPasswordAndPreservesBase(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HOME=/home/user"}
	env := WithEnv(base, "secret-password")

	for _, kv := range base {
		if !slices.Contains(env, kv) {
			t.Errorf("WithEnv dropped base entry %q", kv)
		}
	}
	if !slices.Contains(env, "POCKODE_PASSWORD=secret-password") {
		t.Errorf("WithEnv did not set the password env var, got %v", env)
	}
}

// A child that inherited either spelling would be given two answers to the same
// question, and which one it obeys depends on its own build's precedence rules.
func TestWithEnv_OverridesInheritedCredentials(t *testing.T) {
	base := []string{"POCKODE_PASSWORD=stale", "POCKODE_AUTH_TOKEN=stale-legacy", "PATH=/usr/bin"}
	env := WithEnv(base, "fresh")

	count := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "POCKODE_AUTH_TOKEN=") {
			t.Errorf("WithEnv kept the deprecated env var %q", kv)
		}
		if strings.HasPrefix(kv, "POCKODE_PASSWORD=") {
			count++
			if kv != "POCKODE_PASSWORD=fresh" {
				t.Errorf("password env = %q, want POCKODE_PASSWORD=fresh", kv)
			}
		}
	}
	if count != 1 {
		t.Errorf("expected exactly one password env entry, got %d", count)
	}
}

func TestClearFlags(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{"separate value", []string{"-port", "1", "-password", "secret", "-dev"}, []string{"-port", "1", "-password=", "-dev"}},
		{"double dash", []string{"--password", "secret"}, []string{"--password="}},
		{"inline value", []string{"-password=secret", "--work=."}, []string{"-password=", "--work=."}},
		{"double dash inline", []string{"--password=secret"}, []string{"--password="}},
		// Under the new name: the version restarted into may have dropped the alias.
		{"legacy flag", []string{"-auth-token", "secret", "--auth-token=x"}, []string{"-password=", "--password="}},
		{"a value that looks like a flag", []string{"-password", "-dev", "-relay=false"}, []string{"-password=", "-relay=false"}},
		{"cluster subcommand", []string{"cluster", "-password", "secret", "-port", "2"}, []string{"cluster", "-password=", "-port", "2"}},
		// A server, since its flags come first: still one, with "cluster" not first.
		{"positional after the flag", []string{"-password", "secret", "cluster"}, []string{"-password=", "cluster"}},
		{"after the terminator", []string{"-dev", "--", "-password", "x"}, []string{"-dev", "--", "-password", "x"}},
		{"similar names are kept", []string{"-passwords", "x", "-password-file=y"}, []string{"-passwords", "x", "-password-file=y"}},
		{"trailing flag without value", []string{"-dev", "-password"}, []string{"-dev", "-password="}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClearFlags(tc.args); !slices.Equal(got, tc.want) {
				t.Errorf("ClearFlags(%q) = %q, want %q", tc.args, got, tc.want)
			}
		})
	}
}

// An emptied flag hands the password over to the variable, and says nothing
// about a deprecated name.
func TestResolve_EmptiedFlagsFallThroughToEnv(t *testing.T) {
	clearEnv(t)
	t.Setenv(EnvVar, "from-env")

	cred, err := Resolve("", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if cred.Password != "from-env" || cred.DeprecationWarning != "" {
		t.Errorf("Resolve = %+v, want the variable's password and no warning", cred)
	}
}
