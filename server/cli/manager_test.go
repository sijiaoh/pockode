package cli

import (
	"os"
	"testing"

	"github.com/pockode/server/globalconfig"
)

func TestParseManagerStart_FromGlobalConfig(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	// Create config with auth token
	cfgStore, err := globalconfig.NewConfigStore()
	if err != nil {
		t.Fatalf("failed to create config store: %v", err)
	}
	if err := cfgStore.Update(globalconfig.Config{
		AuthToken:   "test-token-123",
		DefaultPort: 8080,
		CloudURL:    "https://test.pockode.com",
	}); err != nil {
		t.Fatalf("failed to update config: %v", err)
	}

	cfg, err := ParseManagerStart([]string{})
	if err != nil {
		t.Fatalf("ParseManagerStart failed: %v", err)
	}

	if cfg.AuthToken != "test-token-123" {
		t.Errorf("expected auth token 'test-token-123', got '%s'", cfg.AuthToken)
	}
	if cfg.Port != 8080 {
		t.Errorf("expected port 8080, got %d", cfg.Port)
	}
	if cfg.CloudURL != "https://test.pockode.com" {
		t.Errorf("expected cloud URL 'https://test.pockode.com', got '%s'", cfg.CloudURL)
	}
}

func TestParseManagerStart_OverridePort(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	cfgStore, err := globalconfig.NewConfigStore()
	if err != nil {
		t.Fatalf("failed to create config store: %v", err)
	}
	if err := cfgStore.Update(globalconfig.Config{
		AuthToken:   "token",
		DefaultPort: 8080,
	}); err != nil {
		t.Fatalf("failed to update config: %v", err)
	}

	cfg, err := ParseManagerStart([]string{"--port", "9999"})
	if err != nil {
		t.Fatalf("ParseManagerStart failed: %v", err)
	}

	if cfg.Port != 9999 {
		t.Errorf("expected port 9999, got %d", cfg.Port)
	}
}

func TestParseManagerStart_OverrideToken(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	cfg, err := ParseManagerStart([]string{"--auth-token", "override-token"})
	if err != nil {
		t.Fatalf("ParseManagerStart failed: %v", err)
	}

	if cfg.AuthToken != "override-token" {
		t.Errorf("expected auth token 'override-token', got '%s'", cfg.AuthToken)
	}
}

func TestParseManagerStart_EnvFallback(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	t.Setenv("AUTH_TOKEN", "env-token")
	globalconfig.ResetDir()

	cfg, err := ParseManagerStart([]string{})
	if err != nil {
		t.Fatalf("ParseManagerStart failed: %v", err)
	}

	if cfg.AuthToken != "env-token" {
		t.Errorf("expected auth token 'env-token', got '%s'", cfg.AuthToken)
	}
}

func TestParseManagerStart_NoToken(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	os.Unsetenv("AUTH_TOKEN")
	globalconfig.ResetDir()

	_, err := ParseManagerStart([]string{})
	if err == nil {
		t.Error("expected error when no auth token is provided")
	}
}

func TestRunManager_Help(t *testing.T) {
	result, err := runManager([]string{"help"})
	if err != nil {
		t.Errorf("runManager help failed: %v", err)
	}
	if !result.Handled {
		t.Error("expected handled to be true for help")
	}
}

func TestRunManager_UnknownSubcommand(t *testing.T) {
	_, err := runManager([]string{"unknown"})
	if err == nil {
		t.Error("expected error for unknown subcommand")
	}
}

func TestRunManager_NoArgs(t *testing.T) {
	result, err := runManager([]string{})
	if err != nil {
		t.Errorf("runManager with no args failed: %v", err)
	}
	if !result.Handled {
		t.Error("expected handled to be true for no args")
	}
}

func TestRunManager_StartReturnsManagerMode(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	t.Setenv("AUTH_TOKEN", "test-token")
	globalconfig.ResetDir()

	result, err := runManager([]string{"start"})
	if err != nil {
		t.Fatalf("runManager start failed: %v", err)
	}
	if !result.Handled {
		t.Error("expected handled to be true")
	}
	if result.Mode != ModeManager {
		t.Errorf("expected mode to be ModeManager, got %v", result.Mode)
	}
	if result.ManagerConfig == nil {
		t.Error("expected ManagerConfig to be set")
	}
}

func TestParseManagerStart_ConfigPriority(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	t.Setenv("AUTH_TOKEN", "env-token")
	globalconfig.ResetDir()

	// Set config with different values
	cfgStore, err := globalconfig.NewConfigStore()
	if err != nil {
		t.Fatalf("failed to create config store: %v", err)
	}
	if err := cfgStore.Update(globalconfig.Config{
		AuthToken:   "config-token",
		DefaultPort: 7777,
	}); err != nil {
		t.Fatalf("failed to update config: %v", err)
	}

	// Flag should override config which overrides env
	cfg, err := ParseManagerStart([]string{"--auth-token", "flag-token", "--port", "9999"})
	if err != nil {
		t.Fatalf("ParseManagerStart failed: %v", err)
	}

	if cfg.AuthToken != "flag-token" {
		t.Errorf("expected flag token 'flag-token', got '%s'", cfg.AuthToken)
	}
	if cfg.Port != 9999 {
		t.Errorf("expected port 9999, got %d", cfg.Port)
	}
}

func TestParseManagerStart_ConfigOverridesEnv(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	t.Setenv("AUTH_TOKEN", "env-token")
	globalconfig.ResetDir()

	// Config token should be used over env
	cfgStore, err := globalconfig.NewConfigStore()
	if err != nil {
		t.Fatalf("failed to create config store: %v", err)
	}
	if err := cfgStore.Update(globalconfig.Config{
		AuthToken: "config-token",
	}); err != nil {
		t.Fatalf("failed to update config: %v", err)
	}

	cfg, err := ParseManagerStart([]string{})
	if err != nil {
		t.Fatalf("ParseManagerStart failed: %v", err)
	}

	if cfg.AuthToken != "config-token" {
		t.Errorf("expected config token 'config-token', got '%s'", cfg.AuthToken)
	}
}
