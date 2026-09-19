package password

import (
	"os"
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
		if err == nil || !strings.Contains(err.Error(), "--auth-token") {
			t.Fatalf("Resolve() error = %v, want one naming --auth-token", err)
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
