package authtoken

import (
	"os"
	"testing"
)

func TestResolve_PrefersFlag(t *testing.T) {
	t.Setenv(EnvVar, "from-env")
	if got := Resolve("from-flag"); got != "from-flag" {
		t.Errorf("Resolve() = %q, want from-flag", got)
	}
}

func TestResolve_FallsBackToEnv(t *testing.T) {
	t.Setenv(EnvVar, "from-env")
	if got := Resolve(""); got != "from-env" {
		t.Errorf("Resolve() = %q, want from-env", got)
	}
}

func TestResolve_EmptyWhenNeitherSet(t *testing.T) {
	t.Setenv(EnvVar, "")
	if got := Resolve(""); got != "" {
		t.Errorf("Resolve() = %q, want empty", got)
	}
}

func TestLoad_ReturnsEnvTokenAndScrubs(t *testing.T) {
	t.Setenv(EnvVar, "from-env")
	if got := Load(""); got != "from-env" {
		t.Errorf("Load() = %q, want from-env", got)
	}
	if v, ok := os.LookupEnv(EnvVar); ok {
		t.Errorf("%s still set after Load = %q, want unset", EnvVar, v)
	}
}

func TestLoad_ScrubsEvenWhenTokenFromFlag(t *testing.T) {
	t.Setenv(EnvVar, "stale-env")
	if got := Load("from-flag"); got != "from-flag" {
		t.Errorf("Load() = %q, want from-flag", got)
	}
	if _, ok := os.LookupEnv(EnvVar); ok {
		t.Errorf("%s must be unset after Load even when token came from flag", EnvVar)
	}
}
