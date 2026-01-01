package relay

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// ErrFrpcNotFound is returned when frpc is not installed.
var ErrFrpcNotFound = errors.New("frpc not found (see: https://github.com/fatedier/frp)")

type FrpcRunner struct {
	configPath string
	cmd        *exec.Cmd
	log        *slog.Logger
}

func NewFrpcRunner(dataDir string, log *slog.Logger) *FrpcRunner {
	return &FrpcRunner{
		configPath: filepath.Join(dataDir, "frpc.toml"),
		log:        log,
	}
}

func (f *FrpcRunner) CheckInstalled() error {
	_, err := exec.LookPath("frpc")
	if err != nil {
		return ErrFrpcNotFound
	}
	return nil
}

func (f *FrpcRunner) GenerateConfig(cfg *StoredConfig, localPort int) error {
	customDomain := cfg.Subdomain + "." + cfg.FrpServer

	config := fmt.Sprintf(`serverAddr = "%s"
serverPort = %d
auth.token = "%s"

[[proxies]]
name = "http"
type = "http"
localIP = "localhost"
localPort = %d
customDomains = ["%s"]
`, cfg.FrpServer, cfg.FrpPort, cfg.FrpToken, localPort, customDomain)

	if err := os.MkdirAll(filepath.Dir(f.configPath), 0755); err != nil {
		return err
	}

	// Use 0600 to protect the token
	return os.WriteFile(f.configPath, []byte(config), 0600)
}

// Start blocks until frpc exits or context is cancelled.
func (f *FrpcRunner) Start(ctx context.Context) error {
	f.cmd = exec.CommandContext(ctx, "frpc", "-c", f.configPath)
	f.cmd.Stdout = os.Stdout
	f.cmd.Stderr = os.Stderr

	if err := f.cmd.Start(); err != nil {
		return fmt.Errorf("start frpc: %w", err)
	}

	f.log.Info("frpc started", "pid", f.cmd.Process.Pid)

	err := f.cmd.Wait()
	if ctx.Err() != nil {
		// Context cancelled, normal shutdown
		return nil
	}
	if err != nil {
		return fmt.Errorf("frpc exited: %w", err)
	}

	return nil
}

func (f *FrpcRunner) Stop() {
	if f.cmd == nil || f.cmd.Process == nil {
		return
	}

	f.log.Info("stopping frpc", "pid", f.cmd.Process.Pid)

	// Send SIGTERM for graceful shutdown
	f.cmd.Process.Signal(syscall.SIGTERM)

	// Give it 5 seconds to exit gracefully
	done := make(chan struct{})
	go func() {
		f.cmd.Wait()
		close(done)
	}()

	select {
	case <-done:
		f.log.Info("frpc stopped gracefully")
	case <-time.After(5 * time.Second):
		f.log.Warn("frpc did not stop gracefully, killing")
		f.cmd.Process.Kill()
	}
}
