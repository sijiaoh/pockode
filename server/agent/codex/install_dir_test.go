package codex

import "testing"

func TestInstallDirHonoursInstallerOverride(t *testing.T) {
	t.Setenv("CODEX_INSTALL_DIR", "/opt/codex/bin")
	if got := installDir(); got != "/opt/codex/bin" {
		t.Errorf("installDir() = %q, want CODEX_INSTALL_DIR", got)
	}
}

func TestInstallDirDefault(t *testing.T) {
	t.Setenv("CODEX_INSTALL_DIR", "")
	want := setDefaultInstallDirEnv(t)
	if got := installDir(); got != want {
		t.Errorf("installDir() = %q, want %q", got, want)
	}
}
