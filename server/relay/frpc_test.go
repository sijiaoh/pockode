package relay

import (
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestFrpcRunner_CheckInstalled(t *testing.T) {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	runner := NewFrpcRunner(t.TempDir(), log)

	err := runner.CheckInstalled()

	_, lookErr := exec.LookPath("frpc")
	if lookErr != nil {
		if err != ErrFrpcNotFound {
			t.Errorf("CheckInstalled() error = %v, want ErrFrpcNotFound", err)
		}
	} else {
		if err != nil {
			t.Errorf("CheckInstalled() error = %v", err)
		}
	}
}

func TestFrpcRunner_GenerateConfig(t *testing.T) {
	tests := []struct {
		name      string
		cfg       *StoredConfig
		localPort int
		wantParts []string
	}{
		{
			name: "production config",
			cfg: &StoredConfig{
				Subdomain:  "abc123def456ghi789jkl0123",
				FrpServer:  "cloud.pockode.com",
				FrpPort:    7000,
				FrpToken:   "secret_token",
				FrpVersion: "0.65.0",
			},
			localPort: 8080,
			wantParts: []string{
				`serverAddr = "cloud.pockode.com"`,
				`serverPort = 7000`,
				`auth.token = "secret_token"`,
				`type = "http"`,
				`localPort = 8080`,
				`customDomains = ["abc123def456ghi789jkl0123.cloud.pockode.com"]`,
			},
		},
		{
			name: "local development config",
			cfg: &StoredConfig{
				Subdomain:  "dev123",
				FrpServer:  "local.pockode.com",
				FrpPort:    7000,
				FrpToken:   "dev_token",
				FrpVersion: "0.65.0",
			},
			localPort: 8080,
			wantParts: []string{
				`serverAddr = "local.pockode.com"`,
				`serverPort = 7000`,
				`customDomains = ["dev123.local.pockode.com"]`,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			log := slog.New(slog.NewTextHandler(os.Stderr, nil))
			runner := NewFrpcRunner(dir, log)

			err := runner.GenerateConfig(tt.cfg, tt.localPort)
			if err != nil {
				t.Fatalf("GenerateConfig() error = %v", err)
			}

			content, err := os.ReadFile(runner.configPath)
			if err != nil {
				t.Fatalf("ReadFile() error = %v", err)
			}

			for _, part := range tt.wantParts {
				if !strings.Contains(string(content), part) {
					t.Errorf("Config missing %q\nGot:\n%s", part, content)
				}
			}
		})
	}
}

func TestFrpcRunner_ConfigFilePermissions(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	runner := NewFrpcRunner(dir, log)

	cfg := &StoredConfig{
		Subdomain: "test",
		FrpServer: "cloud.pockode.com",
		FrpPort:   7000,
		FrpToken:  "secret_token",
	}

	if err := runner.GenerateConfig(cfg, 8080); err != nil {
		t.Fatalf("GenerateConfig() error = %v", err)
	}

	info, err := os.Stat(runner.configPath)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}

	perm := info.Mode().Perm()
	if perm&0077 != 0 {
		t.Errorf("Config file permissions = %o, want 0600 (no group/other access)", perm)
	}
}
